//
//  app.ts
//  MetalPriceKit Server
//  HTTP 装配层：路由、中间件、加密响应。
//
//  三条设计主线：
//
//  1. 路径混淆
//     对外路径全部来自 config/routes.json，是无意义随机串，
//     从 URL 上看不出这个接口是干什么的。真正的接口名只存在于代码内部。
//
//  2. 响应加密
//     业务接口一律返回密文信封。客户端先用 bootstrap 拿到服务端公钥，
//     自己生成 X25519 密钥对，每次请求带上自己的公钥（X-MPK-CK 头），
//     服务端用 ECDH 派生出会话密钥再加密响应。
//     没有加密能力的调用方（例如探活脚本）可以带 X-MPK-Plain: 1 拿明文，
//     但这只应用于调试 —— 生产环境该头不开放。
//
//  3. 契约形状保持不变
//     加密只发生在传输层。解密后的 JSON 与 Docs/服务端API设计.md 里
//     约定的结构一模一样，客户端的 Decodable 不用改。
//

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "./config.ts";
import type { Collector } from "./collector.ts";
import type { Store } from "./store.ts";
import type { UserStore, UserRecord } from "./userstore.ts";
import { ConfigStore } from "./configstore.ts";
import { buildFxPayload, buildMetalsPayload, buildQuotesPayload } from "./market.ts";
import { buildAad, deriveSessionKey, isEnvelope, open, seal } from "./crypto.ts";
import { RateLimiter } from "./ratelimit.ts";
import { log } from "./logger.ts";

export interface AppDeps {
  config: ServerConfig;
  collector: Collector;
  store: Store;
  users: UserStore;
  genericConfig: ConfigStore;
}

/** 客户端公钥头。值是 base64 编码的 32 字节 X25519 raw 公钥。 */
const CLIENT_PUB_HEADER = "x-mpk-ck";
/** 明文逃生舱。仅供调试。 */
const PLAIN_HEADER = "x-mpk-plain";

export function createApp(deps: AppDeps): express.Express {
  const { config, collector, store, users, genericConfig } = deps;
  const app = express();
  const routes = config.routes;

  app.disable("x-powered-by");
  app.set("etag", false);

  // 信任一层代理。生产环境 Nginx 在前面，不开这个的话 req.ip 永远是 127.0.0.1，
  // 全站用户会被算成同一个 IP —— 60/min 的限流会误伤所有人。
  //
  // 用数字 1 而不是 true：只信任「离服务端最近的那一跳」。
  // 客户端自己伪造 X-Forwarded-For 时，Nginx 会把自己的 $remote_addr 追加在末尾，
  // 于是取到的仍然是真实客户端 IP。
  app.set("trust proxy", 1);

  const ipLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });
  const tokenLimiter = new RateLimiter({ windowMs: 60_000, max: 30 });

  // ── 中间件 ────────────────────────────────────────────────────

  // 请求追踪 ID。放响应头，用户报障时报这个号就能定位到那一次请求。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-request-id");
    const requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
    res.setHeader("X-Request-Id", requestId);
    next();
  });

  app.use(express.json({ limit: "256kb" }));

  // IP 限流兜底。token 限流在需要鉴权的接口上另算。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const { allowed, retryAfterSeconds } = ipLimiter.hit(key);
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    next();
  });

  // ── 加密响应工具 ───────────────────────────────────────────────

  /**
   * 算出这次请求的会话密钥。
   *
   * 客户端每次请求都带自己的 X25519 公钥，服务端用自己的私钥做 ECDH，
   * 双方各自得到同一把会话密钥。没有公钥就返回 null（走明文）。
   */
  function sessionKeyFor(req: Request): { key: Buffer; kid: string } | null {
    const raw = req.header(CLIENT_PUB_HEADER);
    if (!raw) return null;
    let clientPub: Buffer;
    try {
      clientPub = Buffer.from(raw, "base64");
    } catch {
      return null;
    }
    if (clientPub.length !== 32) return null;
    const kid = config.activeKid;
    const serverKey = config.serverKeys.find((k) => k.kid === kid);
    if (!serverKey) return null;
    try {
      return { key: deriveSessionKey(serverKey, clientPub, "response"), kid };
    } catch {
      // 长度对但不是有效的 X25519 点（例如全零公钥），OpenSSL 会拒绝派生密钥。
      // 这跟「没有公钥」是同一类问题，按「没有可用公钥」处理，
      // 不要让一个畸形请求把服务打成 500。
      return null;
    }
  }

  function wantsPlaintext(req: Request): boolean {
    return process.env.NODE_ENV === "development" && req.header(PLAIN_HEADER) === "1";
  }

  /**
   * 响应是否必须加密。
   *
   * 默认必须加密。没有客户端公钥就返回明文，等于加密形同虚设 ——
   * 谁 curl 一下都能拿到价格。只有显式开发模式才放开。
   */
  function encryptionRequired(): boolean {
    return process.env.NODE_ENV !== "development";
  }

  /**
   * 发送响应。加密时把明文 JSON 装进信封；明文时直接发。
   *
   * ETag 基于「明文的规范化 JSON」计算 —— 这样 304 命中时，
   * 客户端本地缓存的是明文，两边对得上。
   */
  function send(
    req: Request,
    res: Response,
    payload: unknown,
    options: { cacheControl: string; status?: number },
  ): void {
    const plaintext = JSON.stringify(payload);
    const session = sessionKeyFor(req);

    // 加密是硬要求：拿不到客户端公钥就报错，不降级成明文。
    if (!session && encryptionRequired()) {
      res.status(400).json({ error: "client_key_required" });
      return;
    }

    const etag = `"${createHash("sha256").update(etagSource(payload)).digest("base64url")}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", options.cacheControl);

    const ifNoneMatch = req.header("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag)) {
      res.status(304).end();
      return;
    }

    if (!session || wantsPlaintext(req)) {
      res.setHeader("X-MPK-Encrypted", "0");
      res.status(options.status ?? 200).type("application/json").send(plaintext);
      return;
    }

    const aad = buildAad(req.method, req.path, session.kid);
    const envelope = seal(plaintext, session.key, session.kid, aad);
    res.setHeader("X-MPK-Encrypted", "1");
    res.setHeader("X-MPK-Kid", session.kid);
    res.status(options.status ?? 200).type("application/json").send(JSON.stringify(envelope));
  }

  /** 取出请求里的业务数据。请求体可以是明文 JSON，也可以是加密信封。 */
  function readBody(req: Request): unknown {
    const body = req.body as unknown;
    if (!isEnvelope(body)) return body;

    const clientPubRaw = req.header(CLIENT_PUB_HEADER);
    if (!clientPubRaw) throw new HttpError(400, "请求体是加密信封，但缺少客户端公钥头");
    const kid = body.kid;
    const serverKey = config.serverKeys.find((k) => k.kid === kid);
    if (!serverKey) throw new HttpError(400, `未知的密钥标识 ${kid}`);

    const clientPub = Buffer.from(clientPubRaw, "base64");
    if (clientPub.length !== 32) throw new HttpError(400, "客户端公钥长度应为 32 字节");

    let plaintext: string;
    try {
      const key = deriveSessionKey(serverKey, clientPub, "request");
      plaintext = open(body, key, buildAad(req.method, req.path, kid));
    } catch (err) {
      // 解不开就是解不开，不猜、不兜底成空对象。
      throw new HttpError(400, `请求体解密失败：${(err as Error).message}`);
    }
    try {
      return JSON.parse(plaintext);
    } catch {
      throw new HttpError(400, "请求体解密后不是合法 JSON");
    }
  }

  /** 从 Authorization 头取 token 并解析出用户。 */
  function currentUser(req: Request): UserRecord | null {
    const header = req.header("authorization");
    if (!header) return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return null;
    return users.resolveToken(m[1]!);
  }

  /**
   * token 维度限流。
   *
   * 比 IP 限流更准：同一 WiFi 下的家庭/办公室成员不会被互相误伤。
   * 行情类接口不限 token（它们本来就不需要 token，IP 限流已经兜底）。
   */
  function checkTokenLimit(req: Request, res: Response): boolean {
    const header = req.header("authorization");
    if (!header) return true;
    const key = `token:${header.slice(0, 128)}`;
    const { allowed, retryAfterSeconds } = tokenLimiter.hit(key);
    if (!allowed) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }
    return allowed;
  }

  // ── 运维接口（不加密、不混淆）─────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    const h = collector.health;
    res.json({
      status: "ok",
      lastFetchAt: h.lastFetchAt,
      lastFetchOk: h.lastFetchOk,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get("/version", (_req: Request, res: Response) => {
    res.json({ version: "0.1.0", node: process.version });
  });

  // ── 密钥协商（明文，只有公钥，无敏感信息）──────────────────────

  /**
   * 客户端握手：拿到服务端公钥表。
   *
   * 这个接口必须明文 —— 客户端还没有任何密钥，没法解密。
   * 它只暴露公钥，泄露了也没关系。
   */
  app.get(routes.bootstrap, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "max-age=3600");
    res.json({
      v: 1,
      algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
      keys: config.serverKeys.map((k) => ({
        kid: k.kid,
        publicKey: k.publicKey.toString("base64"),
      })),
    });
  });

  // ── 行情接口 ───────────────────────────────────────────────────

  app.get(routes.quotes, (req: Request, res: Response) => {
    const snapshot = collector.currentSnapshot;
    if (!snapshot) {
      // 还没有任何快照（刚启动还没抓到第一轮）。
      // 这是服务端自身状态问题，返回 503 让客户端走重试。
      res.status(503).json({ error: "snapshot_unavailable" });
      return;
    }
    const codes = config.metals.map((m) => m.code);
    const tradeDate = snapshot.metalAsOf.slice(0, 10);
    const prevCloses = store.prevCloseMap(codes, tradeDate);
    const prevChanges = store.prevChangeMap(codes, tradeDate);
    const payload = buildQuotesPayload(config, snapshot, prevCloses, prevChanges);
    send(req, res, payload, { cacheControl: "no-cache" });
  });

  app.get(routes.metals, (req: Request, res: Response) => {
    send(req, res, buildMetalsPayload(config), { cacheControl: "max-age=86400" });
  });

  app.get(routes.fx, (req: Request, res: Response) => {
    const snapshot = collector.currentSnapshot;
    if (!snapshot) {
      res.status(503).json({ error: "snapshot_unavailable" });
      return;
    }
    send(req, res, buildFxPayload(snapshot), { cacheControl: "max-age=3600" });
  });

  // ── 配置接口 ───────────────────────────────────────────────────

  /**
   * 契约里的结构化配置（契约 3.1）。
   * 固定结构，客户端按强类型解码。
   *
   * 结构由契约定死，但**值**来自通用配置文件（config/remote-config.json），
   * 不在代码里再存一份 —— 两份副本迟早会漂移，改文案还要发版。
   * 文件缺项时才用兜底值。
   */
  app.get(routes.config, (req: Request, res: Response) => {
    const generic = genericConfig.load();
    const values = generic.values;

    const payload = {
      serverTime: new Date().toISOString(),
      configVersion: generic.configVersion,
      features: asObject(values["features"]) ?? { showGuide: true, guideVersion: 1 },
      runtime: {
        // 客户端轮询「我们」的间隔。由配置文件决定，改完热生效，不用发版。
        pollIntervalSeconds:
          typeof values["pollIntervalSeconds"] === "number" ? values["pollIntervalSeconds"] : 15,
        // 我们拉上游的间隔 —— 数据本身多久更新一次。
        // 客户端据此判断要不要提示「数据较旧」，别让用户以为是秒级实时。
        upstreamRefreshSeconds: Math.round(config.pollIntervalMs / 1000),
      },
      app: {
        minSupportedVersion: "1.0.0",
        latestVersion: "1.0.0",
        updateUrl: "",
      },
      marketing: asObject(values["marketing"]) ?? {
        bannerText: "",
        bannerUrl: "",
        noticeTitle: "行情数据说明",
        noticeContent: "本应用行情来自第三方数据源，可能存在延迟，仅供参考，不构成投资建议。",
      },
    };
    send(req, res, payload, { cacheControl: "max-age=300" });
  });

  /**
   * 通用字段接口：下发任意 [key: Any] 字典。
   *
   * 内容来自 config/remote-config.json，改文件即生效，不用重启、不用发版。
   * 客户端按 [String: Any] 解码，取自己认识的 key，不认识的忽略。
   */
  app.get(routes.fields, (req: Request, res: Response) => {
    const generic = genericConfig.load();
    send(req, res, generic.values, { cacheControl: "max-age=300" });
  });

  // ── 匿名身份 ───────────────────────────────────────────────────

  app.post(routes.auth, (req: Request, res: Response) => {
    const body = readBody(req) as { deviceId?: string; appVersion?: string; build?: string };
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 128) {
      res.status(400).json({ error: "invalid_device_id" });
      return;
    }

    const { user, isNewUser } = users.findOrCreateByDevice(deviceId);
    const { token, expiresAt } = users.issueToken(user.id, deviceId);
    const payload = {
      userId: user.id,
      token,
      expiresAt,
      isNewUser,
      profile: {
        nickname: user.nickname,
        settings: user.settings,
      },
    };
    send(req, res, payload, { cacheControl: "no-store", status: 200 });
  });

  // ── 用户资料 ───────────────────────────────────────────────────

  app.get(routes.profile, (req: Request, res: Response) => {
    if (!checkTokenLimit(req, res)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    send(req, res, buildProfilePayload(user, users.deviceCount(user.id)), {
      cacheControl: "no-store",
    });
  });

  app.patch(routes.profile, (req: Request, res: Response) => {
    if (!checkTokenLimit(req, res)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = readBody(req) as {
      nickname?: string;
      settings?: Record<string, unknown>;
    };
    const updated = users.updateUser(user.id, {
      nickname: typeof body?.nickname === "string" ? body.nickname.slice(0, 64) : undefined,
      settings: body?.settings,
    });
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    send(req, res, buildProfilePayload(updated, users.deviceCount(updated.id)), {
      cacheControl: "no-store",
    });
  });

  // ── 反馈 / 崩溃 / 埋点 ─────────────────────────────────────────

  app.post(routes.feedback, (req: Request, res: Response) => {
    if (!checkTokenLimit(req, res)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    // 契约 §1.4：反馈需要 token —— 反馈要能关联到人，否则工单没法回访。
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = readBody(req) as {
      category?: string;
      content?: string;
      contact?: string;
      attachments?: unknown[];
      appState?: unknown;
    };
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) {
      res.status(400).json({ error: "invalid_content" });
      return;
    }
    const ticketId = users.insertFeedback({
      userId: user.id,
      category: typeof body?.category === "string" ? body.category.slice(0, 32) : "other",
      content: content.slice(0, 4000),
      contact: typeof body?.contact === "string" ? body.contact.slice(0, 200) : "",
      attachments: Array.isArray(body?.attachments) ? body.attachments.slice(0, 9) : [],
      appState: body?.appState ?? {},
    });
    send(req, res, { ticketId, createdAt: new Date().toISOString() }, {
      cacheControl: "no-store",
      status: 201,
    });
  });

  app.post(routes.crash, (req: Request, res: Response) => {
    // 崩溃上报允许匿名：崩溃时客户端可能还没拿到 token。
    const user = currentUser(req);
    const body = readBody(req);
    users.insertCrash(user?.id ?? null, body);
    res.status(204).end();
  });

  app.post(routes.events, (req: Request, res: Response) => {
    if (!checkTokenLimit(req, res)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    // 契约接口总表：埋点需要 token。
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = readBody(req) as { sessionId?: string; events?: unknown[] };
    users.insertEvents(user.id, body?.sessionId ?? null, body?.events ?? []);
    res.status(204).end();
  });

  // ── 兜底 ───────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  // 统一错误处理。绝不把内部堆栈吐给客户端。
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) {
      log("error", "请求处理失败", { path: req.path, error: err.message });
    } else {
      log("warn", "请求被拒绝", { path: req.path, status, error: err.message });
    }
    if (res.headersSent) return;
    res.status(status).json({ error: status === 400 ? "bad_request" : "internal_error" });
  });

  return app;
}

/** 带 HTTP 状态码的业务错误。统一错误处理按它决定返回什么状态码。 */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function buildProfilePayload(user: UserRecord, deviceCount: number) {
  return {
    userId: user.id,
    createdAt: user.createdAt,
    nickname: user.nickname,
    settings: user.settings,
    deviceCount,
  };
}

/**
 * ETag 的计算依据。
 *
 * serverTime 是「本次响应的时刻」，每次请求都不一样 —— 把它算进 ETag，
 * 客户端的 If-None-Match 永远匹配不上，304 就形同虚设。
 * 所以 ETag 只对内容敏感的字段负责：语义就是「资源内容没变」。
 */
function etagSource(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    delete copy["serverTime"];
    return JSON.stringify(copy);
  }
  return JSON.stringify(payload);
}

/** 取一个 JSON 对象，取不到就返回 null。用来把通用配置里的子对象安全取出来。 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
