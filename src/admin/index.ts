//
//  admin/index.ts
//  MetalPriceKit Server
//  运营后台的路由装配。
//
//  访问方式：只监听 127.0.0.1，远程用 SSH 隧道。
//  生产环境在 Nginx 里显式屏蔽 /admin —— 双保险，万一有人把监听地址改成 0.0.0.0，
//  公网上也访问不到后台。
//
//  鉴权：独立的管理口令（MPK_ADMIN_TOKEN），换取 HttpOnly 会话 cookie。
//  与客户端的匿名 token 完全隔离 —— 客户端 token 几乎人手一个，
//  把它和运营权限混在一起，一个泄漏就等于后台敞开。
//
//  页面零 JavaScript：所有操作都是原生表单提交。
//  后台就三个页面，用不着 SPA，写个前端框架反而多一套构建流程。
//

import express from "express";
import type { Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AdminAuth } from "./auth.ts";
import { collectStats, listUsers, listUsersForExport } from "./stats.ts";
import { configPage, dashboardPage, loginPage, usersPage } from "./pages.ts";
import { ConfigError, ConfigStore, type BackupInfo } from "../configstore.ts";
import { RateLimiter } from "../ratelimit.ts";

export interface AdminDeps {
  /** 用户库。后台的统计全部来自这张库。 */
  db: DatabaseSync;
  genericConfig: ConfigStore;
  /** 管理口令。没配就是后台没启用。 */
  adminToken: string;
  /**
   * 后台是否只允许回环地址访问。
   *
   * 开发阶段（纯内网、全部自己人用）设 false —— 后台跟着服务一起在局域网上开放，
   * 手机连本机调试时顺便就能开后台看统计，不用再开 SSH 隧道。
   * 生产环境保持 true —— 公网上绝不暴露后台。
   *
   * 判定依据是请求的来源 IP：来自 127.0.0.1 / ::1 的放行，
   * 其余一律 403。走 SSH 隧道时 Nginx 传来的 X-Forwarded-For 是真实客户端 IP，
   * 但隧道入口本身在服务器上就是回环，所以那种部署不受影响。
   */
  localOnly: boolean;
}

const CSS_PATH = resolve(import.meta.dirname, "assets/admin.css");

/** 后台表单里 CSRF 字段的名字。 */
const CSRF_FIELD = "csrf";
/** JSON 接口用的 CSRF 头。 */
const CSRF_HEADER = "x-mpk-admin-csrf";

export function registerAdminRoutes(app: express.Express, deps: AdminDeps): void {
  const { db, genericConfig, adminToken, localOnly } = deps;

  // 表单提交用 application/x-www-form-urlencoded。
  // 只挂在 /admin 上 —— 客户端接口全是 JSON，不该多解析一种 body。
  app.use("/admin", express.urlencoded({ extended: false, limit: "256kb" }));

  // 静态样式。放最前面，未登录也要能拿到（登录页也要样式）。
  app.get("/admin/static/admin.css", (_req: Request, res: Response) => {
    res.type("text/css").setHeader("Cache-Control", "max-age=3600").send(readFileSync(CSS_PATH, "utf8"));
  });

  /**
   * 回环地址判断。
   *
   * 只认 127.0.0.0/8 和 ::1。IPv4-mapped 的 ::ffff:127.0.0.1 也算回环 ——
   * 双栈栈下 Node 看到的是这个形式。
   */
  function isLoopback(req: Request): boolean {
    const ip = req.ip ?? req.socket.remoteAddress ?? "";
    const bare = ip.replace(/^::ffff:/, "");
    return bare === "::1" || bare.startsWith("127.");
  }

  /** 生产模式下的额外护栏：非回环来源一律拒绝访问后台。 */
  function requireLocal(req: Request, res: Response, next: express.NextFunction): void {
    if (!localOnly || isLoopback(req)) {
      next();
      return;
    }
    res.status(403).type("text/html").send(
      `<!DOCTYPE html><meta charset="utf-8"><title>后台仅限本机访问</title>` +
        `<body style="font-family:system-ui;padding:40px">后台仅限本机访问。` +
        `需要远程访问请走 SSH 隧道：<code>ssh -L 8787:127.0.0.1:8787 user@server</code></body>`,
    );
  }

  if (!adminToken) {
    // 没配口令就是没开后台。返回 503 而不是 404 ——
    // 404 会让人以为是路径写错了，503 + 提示才能说明「是配置没做」。
    app.use("/admin", (_req: Request, res: Response) => {
      res.status(503).type("text/html").send(
        `<!DOCTYPE html><meta charset="utf-8"><title>后台未启用</title>` +
          `<body style="font-family:system-ui;padding:40px">后台未启用：服务端没有配置环境变量 ` +
          `<code>MPK_ADMIN_TOKEN</code>。</body>`,
      );
    });
    return;
  }

  const auth = new AdminAuth(adminToken);
  // 登录限流。口令猜错了也是要能试的，但无限试等于没有口令。
  const loginLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });

  /** 取当前会话值；无效返回 null。 */
  function sessionOf(req: Request): string | null {
    const session = auth.readSession(req);
    return auth.isValid(session) ? session : null;
  }

  /**
   * CSRF 校验。
   *
   * 页面表单把会话值原样带回，JSON 接口走请求头。跨站攻击者读不到我们的页面，
   * 也发不了自定义请求头，所以两个通道都被堵住。
   * （cookie 是 SameSite=Strict，跨站请求压根不会带上它 —— 这是第二道保险。）
   */
  function checkCsrf(req: Request): boolean {
    const session = sessionOf(req);
    if (!session) return false;
    const fromBody = (req.body as Record<string, unknown> | undefined)?.[CSRF_FIELD];
    const fromHeader = req.header(CSRF_HEADER);
    const provided = typeof fromBody === "string" && fromBody ? fromBody : fromHeader;
    if (!provided) return false;
    return provided === session;
  }

  /** 未登录时：页面跳转登录页，接口返回 401 JSON。 */
  function requireAuth(req: Request, res: Response, next: express.NextFunction): void {
    if (sessionOf(req)) {
      next();
      return;
    }
    // 后台路由是挂在 app 上的完整路径，所以 req.path 就是 /admin/api/xxx。
    if (req.path.startsWith("/admin/api/")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.redirect(302, "/admin/login");
  }

  // 本机限制挂在所有后台路由前面 —— 登录页也要挡，
  // 否则「后台没开」这件事本身就成了一个可探测的信息。
  app.use("/admin", requireLocal);

  // ── 登录 / 登出 ────────────────────────────────────────────────

  app.get("/admin", (_req: Request, res: Response) => {
    res.redirect(302, "/admin/dashboard");
  });

  app.get("/admin/login", (req: Request, res: Response) => {
    if (sessionOf(req)) {
      res.redirect(302, "/admin/dashboard");
      return;
    }
    res.type("text/html").send(loginPage(null));
  });

  app.post("/admin/login", (req: Request, res: Response) => {
    const body = req.body as { token?: string };
    const token = typeof body.token === "string" ? body.token : "";
    if (!auth.verifyPassword(token)) {
      // 只在口令猜错的时候计数。
      // 成功登录也计数的话，一个正常人一分钟登录十几次就被自己的后台挡在门外了 ——
      // 限流是防爆破的，不是防正常使用的。
      const key = `admin-login:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
      const { allowed, retryAfterSeconds } = loginLimiter.hit(key);
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).type("text/html").send(loginPage("尝试过于频繁，请稍后再试"));
        return;
      }
      // 口令错了也给一个统一文案，不区分「没配」和「错了」。
      res.status(401).type("text/html").send(loginPage("口令不正确"));
      return;
    }
    auth.setCookie(res, req.secure);
    res.redirect(302, "/admin/dashboard");
  });

  app.post("/admin/logout", (req: Request, res: Response) => {
    auth.clearCookie(res);
    res.redirect(302, "/admin/login");
  });

  // ── 页面 ───────────────────────────────────────────────────────

  app.get("/admin/dashboard", requireAuth, (req: Request, res: Response) => {
    const session = sessionOf(req)!;
    res.type("text/html").send(dashboardPage(collectStats(db), session));
  });

  app.get("/admin/users", requireAuth, (req: Request, res: Response) => {
    const session = sessionOf(req)!;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 10_000_000);
    const result = listUsers(db, { q, limit, offset });
    res.type("text/html").send(usersPage({ result, csrf: session, q, limit, offset }));
  });

  app.get("/admin/config", requireAuth, (req: Request, res: Response) => {
    const session = sessionOf(req)!;
    res.type("text/html").send(
      configPage({
        view: buildConfigView(genericConfig),
        csrf: session,
        message: flashMessage(req),
        error: null,
        warnings: [],
      }),
    );
  });

  // ── 配置控制台的写操作 ─────────────────────────────────────────

  app.post("/admin/config/save", requireAuth, (req: Request, res: Response) => {
    if (!checkCsrf(req)) {
      res.status(403).type("text/html").send(configPage({
        view: buildConfigView(genericConfig),
        csrf: sessionOf(req) ?? "",
        message: null,
        error: "CSRF 校验失败，请刷新页面重试",
        warnings: [],
      }));
      return;
    }

    const body = req.body as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "save";
    const current = genericConfig.readFile();

    const { edits, error } = collectEdits(current.raw, body);

    // 新增字段。解析失败只报这一个字段的错，已经填好的其他字段照样保存。
    const newKey = typeof body.newKey === "string" ? body.newKey.trim() : "";
    if (action === "add" && newKey) {
      if (newKey.startsWith("_")) {
        res.status(400).type("text/html").send(renderConfigError(genericConfig, sessionOf(req) ?? "", "下划线开头的字段名是保留的，不能新建"));
        return;
      }
      if (Object.prototype.hasOwnProperty.call(edits, newKey)) {
        res.status(400).type("text/html").send(renderConfigError(genericConfig, sessionOf(req) ?? "", `字段 ${newKey} 已经存在`));
        return;
      }
      try {
        edits[newKey] = parseValue(
          typeof body.newType === "string" ? body.newType : "string",
          typeof body.newValue === "string" ? body.newValue : "",
        );
      } catch (err) {
        res.status(400).type("text/html").send(renderConfigError(genericConfig, sessionOf(req) ?? "", (err as Error).message, edits));
        return;
      }
    }

    if (error) {
      // 有字段没解析成功。这一次不落盘 —— 半截配置比不改更糟。
      // 但已经填对的内容保留在页面上，不用全部重填。
      res.status(400).type("text/html").send(renderConfigError(genericConfig, sessionOf(req) ?? "", error, edits));
      return;
    }

    try {
      const result = genericConfig.save(edits);
      res.redirect(303, `/admin/config?ok=${encodeURIComponent(`已保存，配置版本 v${result.configVersion}`)}`);
    } catch (err) {
      const message = err instanceof ConfigError
        ? err.message
        : `保存失败：${(err as Error).message}`;
      res.status(400).type("text/html").send(renderConfigError(genericConfig, sessionOf(req) ?? "", message, edits));
    }
  });

  app.post("/admin/config/restore", requireAuth, (req: Request, res: Response) => {
    if (!checkCsrf(req)) {
      res.status(403).type("text/html").send(configPage({
        view: buildConfigView(genericConfig),
        csrf: sessionOf(req) ?? "",
        message: null,
        error: "CSRF 校验失败，请刷新页面重试",
        warnings: [],
      }));
      return;
    }

    const body = req.body as { backup?: string };
    const backup = typeof body.backup === "string" ? body.backup : "";
    try {
      const result = genericConfig.restore(backup);
      res.redirect(303, `/admin/config?ok=${encodeURIComponent(`已回滚到 ${backup}，配置版本 v${result.configVersion}`)}`);
    } catch (err) {
      const message = err instanceof ConfigError
        ? err.message
        : `回滚失败：${(err as Error).message}`;
      res.status(400).type("text/html").send(renderConfigError(genericConfig, sessionOf(req) ?? "", message));
    }
  });

  // ── JSON 接口 ─────────────────────────────────────────────────

  app.get("/admin/api/stats", requireAuth, (_req: Request, res: Response) => {
    res.json(collectStats(db));
  });

  app.get("/admin/api/users", requireAuth, (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 10_000_000);
    res.json(listUsers(db, { q, limit, offset }));
  });

  app.get("/admin/api/users.csv", requireAuth, (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const rows = listUsersForExport(db, q);
    const header = ["用户ID", "昵称", "注册时间", "最后活跃", "启动次数", "App版本", "系统版本", "机型", "语言"];
    const lines = [header, ...rows.map((u) => [
      u.id,
      u.nickname,
      u.createdAt,
      u.lastSeenAt,
      String(u.sessionCount),
      u.appVersion ?? "",
      u.osVersion ?? "",
      u.deviceModel ?? "",
      u.locale ?? "",
    ])];
    // 带 BOM：Excel 打开 UTF-8 CSV 没有 BOM 会把中文显示成乱码。
    const csv = "\uFEFF" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
    res
      .type("text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });

  app.get("/admin/api/config", requireAuth, (_req: Request, res: Response) => {
    res.json(buildConfigView(genericConfig));
  });
}

/** 控制台看到的配置视图。 */
function buildConfigView(
  genericConfig: ConfigStore,
  overrideValues?: Record<string, unknown>,
): {
  configVersion: number;
  updatedAt: string | null;
  filePath: string;
  values: Record<string, unknown>;
  preview: Record<string, unknown>;
  backups: BackupInfo[];
} {
  const file = genericConfig.readFile();
  const loaded = genericConfig.load();
  // 下划线开头的元信息（_comment 之类）不在控制台里编辑，也不下发。
  const values = overrideValues ? stripMetaKeys(overrideValues) : loaded.values;
  return {
    configVersion: file.configVersion,
    updatedAt: file.updatedAt,
    filePath: file.filePath,
    values,
    preview: values,
    backups: genericConfig.listBackups(),
  };
}

/** 去掉下划线开头的元信息。 */
function stripMetaKeys(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("_")) continue;
    out[key] = value;
  }
  return out;
}

/** 出错时重画配置页。把已经填对的值带上，别让人白填一遍。 */
function renderConfigError(
  genericConfig: ConfigStore,
  csrf: string,
  message: string,
  edits?: Record<string, unknown>,
): string {
  const view = buildConfigView(genericConfig, edits);
  return configPage({ view, csrf, message: null, error: message, warnings: [] });
}

/**
 * 从表单里收集字段编辑。
 *
 * 表单是「平行的几列」：keys（JSON 数组）/ t（类型）/ v（值）/ op（保留还是删除）。
 * 按下标对齐解析。
 *
 * 某个字段解析失败时不丢弃整个表单：那个字段退回原值，
 * 其他字段照常收集，最后统一报第一个错。
 */
function collectEdits(
  currentRaw: Record<string, unknown>,
  body: Record<string, unknown>,
): { edits: Record<string, unknown>; error: string | null } {
  const keys = parseKeyList(body["keys"]);
  const types = toArray(body["t"]);
  const values = toArray(body["v"]);
  const ops = toArray(body["op"]);

  if (keys.length !== types.length || keys.length !== values.length || keys.length !== ops.length) {
    return {
      edits: {},
      error: "表单数据不完整，页面可能已经过期，请刷新后重试",
    };
  }

  const edits: Record<string, unknown> = {};
  let firstError: string | null = null;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (ops[i] === "delete") continue;
    if (key.startsWith("_")) continue; // 元信息不在控制台里改
    try {
      edits[key] = parseValue(types[i]!, values[i]!);
    } catch (err) {
      if (!firstError) firstError = `字段 ${key}：${(err as Error).message}`;
      // 这个字段退回原值，其余字段的编辑继续保留。
      if (Object.prototype.hasOwnProperty.call(currentRaw, key)) {
        edits[key] = currentRaw[key];
      }
    }
  }

  // 保留原文件里的下划线元信息（_comment 之类）。
  // 它们不发客户端，但写在文件里当说明用，删了就没了。
  for (const [key, value] of Object.entries(currentRaw)) {
    if (key.startsWith("_") && !Object.prototype.hasOwnProperty.call(edits, key)) {
      edits[key] = value;
    }
  }

  return { edits, error: firstError };
}

function parseKeyList(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? ""));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

/** 按类型解析编辑框里的字符串。 */
export function parseValue(type: string, raw: string): unknown {
  switch (type) {
    case "string":
      return raw;
    case "number": {
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) throw new Error(`不是合法数字：${raw}`);
      return n;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      throw new Error(`布尔值只能是 true 或 false：${raw}`);
    }
    case "null":
      return null;
    case "json": {
      if (raw.trim() === "") return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(`JSON 不合法：${(err as Error).message}`);
      }
    }
    default:
      throw new Error(`未知类型：${type}`);
  }
}

/** 保存成功后的提示走 query 参数传递（redirect 之后不丢）。 */
function flashMessage(req: Request): string | null {
  const ok = req.query.ok;
  return typeof ok === "string" && ok ? ok : null;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
