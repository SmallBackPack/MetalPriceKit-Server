//
//  admin.test.ts
//  MetalPriceKit Server
//  运营后台的端到端测试：登录、会话、统计口径、配置控制台。
//
//  走真实 HTTP 收发（表单提交 + cookie），不 mock 任何一层。
//  后台的正确性主要在两件事上：
//  1. 没登录就拿不到数据（页面跳转、接口 401、CSRF 拦住跨站提交）
//  2. 统计口径是准的（装机数 / 设备数 / DAU 各自算各自的，不能混）
//
//  配置控制台用的是临时目录里的配置文件，绝不碰仓库里的 config/remote-config.json。
//

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp } from "../src/app.ts";
import { Collector } from "../src/collector.ts";
import { Store } from "../src/store.ts";
import { UserStore } from "../src/userstore.ts";
import { ConfigStore, formatConfigJson } from "../src/configstore.ts";
import { MockUpstreamClient } from "../src/mock.ts";
import type { ServerConfig } from "../src/config.ts";

// 开发模式：接口不强制加密，省掉在测试里做一遍密钥协商。
process.env.NODE_ENV = "development";

const ADMIN_TOKEN = "test-admin-token";
const PEPPER = "test-pepper";

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl: string;
let userDb: DatabaseSync;
let configDir: string;
let configFile: string;
let backupDir: string;

const routes = {
  bootstrap: "/v1/mpk-bootstrap",
  quotes: "/v1/gpwwvvew-deevda",
  metals: "/v1/mkkzprqp-vvndte",
  fx: "/v1/tqzxvnrk-lzbor",
  config: "/v1/wqbdtoe-ocfvy",
  fields: "/v1/rtkbmvxw-pflqs",
  auth: "/v1/nrmlkzvc-xdpwo",
  profile: "/v1/bhyftvzu-qmocn",
  feedback: "/v1/oxrjqmie-vlwnk",
  crash: "/v1/zeqmflkd-tvrnh",
  events: "/v1/dfvbzckl-yrgmo",
};

const config = {
  port: 0,
  host: "127.0.0.1",
  upstreamApiKey: "",
  upstreamBaseUrl: "",
  pollIntervalMs: 600_000,
  monthlyRequestBudget: 100,
  serverKeys: [],
  activeKid: "k1",
  metals: [],
  routes,
  currencyAllowlist: ["USD"],
  marketHolidays: [] as string[],
  fetchOnBoot: false,
  mockMode: true,
  dataDir: "data",
  remoteConfigFile: "",
  remoteConfigBackupDir: "",
  adminToken: ADMIN_TOKEN,
  idPepperFile: "",
} as unknown as ServerConfig;

before(async () => {
  configDir = mkdtempSync(resolve(tmpdir(), "mpk-admin-test-"));
  configFile = resolve(configDir, "remote-config.json");
  backupDir = resolve(configDir, "backups");
  // 用同一个序列化器写初始文件 —— 基线排版必须和控制台写出来的一致，
  // 否则「只差一行」的断言没有意义。
  writeFileSync(
    configFile,
    formatConfigJson({
      configVersion: 3,
      _comment: "测试用配置",
      pollIntervalSeconds: 60,
      features: { showGuide: true },
    }),
    "utf8",
  );
  (config as { remoteConfigFile: string }).remoteConfigFile = configFile;
  (config as { remoteConfigBackupDir: string }).remoteConfigBackupDir = backupDir;

  const marketDb = new DatabaseSync(":memory:");
  userDb = new DatabaseSync(":memory:");
  const store = new Store(marketDb);
  const users = new UserStore(userDb, { pepper: PEPPER });
  const upstream = new MockUpstreamClient({ config });
  const collector = new Collector({ config, store, upstream, log: () => {} });
  const genericConfig = new ConfigStore(configFile, { backupDir });

  const app = createApp({ config, collector, store, users, genericConfig });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** 登录，返回 cookie 与 csrf 值。 */
async function login(password = ADMIN_TOKEN): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: password }).toString(),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /mpk_admin=([^;]*)/.exec(setCookie);
  const value = match ? decodeURIComponent(match[1]!) : "";
  return { cookie: `mpk_admin=${value}`, csrf: value };
}

/** 调匿名注册接口。 */
async function register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${routes.auth}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

// ── 鉴权 ───────────────────────────────────────────────────────

test("未登录访问后台页面会跳转登录页", async () => {
  const res = await fetch(`${baseUrl}/admin/dashboard`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin/login");
});

test("未登录访问后台接口返回 401", async () => {
  const res = await fetch(`${baseUrl}/admin/api/stats`, { redirect: "manual" });
  assert.equal(res.status, 401);
});

test("口令错误不给会话", async () => {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "wrong" }).toString(),
    redirect: "manual",
  });
  assert.equal(res.status, 401);
  assert.ok(!(res.headers.get("set-cookie") ?? "").includes("mpk_admin="));
});

test("登录成功拿到会话 cookie，且是 HttpOnly + SameSite=Strict", async () => {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: ADMIN_TOKEN }).toString(),
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /mpk_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/admin/);
});

test("伪造的会话 cookie 不被接受", async () => {
  const res = await fetch(`${baseUrl}/admin/api/stats`, {
    headers: { cookie: "mpk_admin=abc.def" },
    redirect: "manual",
  });
  assert.equal(res.status, 401);
});

// ── 统计口径 ───────────────────────────────────────────────────

test("匿名注册是幂等的，同一个 deviceId 拿到同一个 userId", async () => {
  const first = await register({ deviceId: "idem-device", vendorId: "vendor-idem" });
  const second = await register({ deviceId: "idem-device", vendorId: "vendor-idem" });
  assert.equal(first["userId"], second["userId"]);
  assert.equal(first["isNewUser"], true);
  assert.equal(second["isNewUser"], false);
});

test("设备标识在库里是哈希，不是原文", async () => {
  await register({ deviceId: "raw-device-id-xyz", vendorId: "raw-vendor-abc" });
  const row = userDb
    .prepare(`SELECT device_id, vendor_id FROM users WHERE nickname IS NOT NULL`)
    .all() as { device_id: string; vendor_id: string }[];
  const raw = row.filter((r) => r.device_id === "raw-device-id-xyz" || r.vendor_id === "raw-vendor-abc");
  assert.equal(raw.length, 0, "库里不应出现原始设备标识");
  for (const r of row) {
    assert.match(r.device_id, /^h1:[0-9a-f]{64}$/);
  }
});

test("统计口径：装机基数、设备数、DAU 各算各的", async () => {
  // 三个装机，其中两个装在同一台物理设备上。
  await register({
    deviceId: "stat-device-a",
    vendorId: "stat-vendor-1",
    appVersion: "1.0.0",
    locale: "zh-Hans",
    deviceModel: "iPhone17,1",
  });
  await register({
    deviceId: "stat-device-b",
    vendorId: "stat-vendor-2",
    appVersion: "1.0.0",
    locale: "en-US",
    deviceModel: "iPhone16,1",
  });
  await register({
    deviceId: "stat-device-c",
    vendorId: "stat-vendor-1",
    appVersion: "1.1.0",
    locale: "zh-Hans",
    deviceModel: "iPhone17,1",
  });

  const { cookie } = await login();
  const res = await fetch(`${baseUrl}/admin/api/stats`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const stats = (await res.json()) as {
    overview: Record<string, number>;
    byVersion: { label: string; count: number }[];
    daily: { date: string; dau: number }[];
  };

  // 之前还注册过 idem-device 和 raw-device-id-xyz，所以基数是 5。
  assert.equal(stats.overview.installBase, 5);
  // 物理设备：stat-vendor-1、stat-vendor-2、vendor-idem、raw-vendor-abc = 4。
  assert.equal(stats.overview.deviceCount, 4);
  // 今天活跃：5 个用户都调过 auth。
  assert.equal(stats.overview.dau, 5);
  assert.equal(stats.overview.mau, 5);

  const v110 = stats.byVersion.find((r) => r.label === "1.0.0");
  const v111 = stats.byVersion.find((r) => r.label === "1.1.0");
  assert.equal(v110?.count, 2);
  assert.equal(v111?.count, 1);

  // 日活序列最后一天就是今天，值等于 DAU。
  const today = new Date().toISOString().slice(0, 10);
  const last = stats.daily[stats.daily.length - 1];
  assert.equal(last?.date, today);
  assert.equal(last?.dau, 5);
});

test("看板页面能打开且带上了统计数字", async () => {
  const { cookie } = await login();
  const res = await fetch(`${baseUrl}/admin/dashboard`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /装机基数/);
  assert.match(html, /今日活跃/);
});

test("用户列表可以搜索并导出 CSV", async () => {
  const { cookie } = await login();
  const list = await fetch(`${baseUrl}/admin/api/users?q=stat-device&limit=10`, {
    headers: { cookie },
  });
  assert.equal(list.status, 200);

  const csv = await fetch(`${baseUrl}/admin/api/users.csv`, { headers: { cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  // 必须查原始字节：fetch 的 text() 按 WHATWG 规范会把开头的 BOM 吃掉，
  // 用字符串判断永远看不到它。
  const bytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], "CSV 要带 UTF-8 BOM，否则 Excel 打开是乱码");
  const text = new TextDecoder("utf-8").decode(bytes);
  assert.match(text, /用户ID/);
});

// ── 配置控制台 ─────────────────────────────────────────────────

/** 拼一份配置表单。 */
function configForm(opts: {
  keys: string[];
  types: string[];
  values: string[];
  ops: string[];
  csrf: string;
  newKey?: string;
  newType?: string;
  newValue?: string;
}): string {
  const params = new URLSearchParams();
  params.set("keys", JSON.stringify(opts.keys));
  for (const t of opts.types) params.append("t", t);
  for (const v of opts.values) params.append("v", v);
  for (const op of opts.ops) params.append("op", op);
  params.set("csrf", opts.csrf);
  if (opts.newKey !== undefined) params.set("newKey", opts.newKey);
  if (opts.newType !== undefined) params.set("newType", opts.newType);
  if (opts.newValue !== undefined) params.set("newValue", opts.newValue);
  params.set("action", "save");
  return params.toString();
}

test("配置控制台保存后版本 +1，内容写进文件，并自动备份", async () => {
  const { cookie, csrf } = await login();
  const body = configForm({
    keys: ["pollIntervalSeconds", "features"],
    types: ["number", "json"],
    values: ["45", '{"showGuide": false}'],
    ops: ["keep", "keep"],
    csrf,
  });
  const res = await fetch(`${baseUrl}/admin/config/save`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body,
    redirect: "manual",
  });
  assert.equal(res.status, 303);

  const saved = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  assert.equal(saved["configVersion"], 4);
  assert.equal(saved["pollIntervalSeconds"], 45);
  assert.deepEqual(saved["features"], { showGuide: false });
  // 下划线开头的元信息不能被控制台改没了。
  assert.equal(saved["_comment"], "测试用配置");

  // 备份目录里应该有一份旧版本。
  const backups = readdirSync(backupDir);
  assert.equal(backups.length, 1);
});

test("改动立刻对通用字段接口生效（热加载）", async () => {
  const res = await fetch(`${baseUrl}${routes.fields}`);
  const values = (await res.json()) as Record<string, unknown>;
  assert.equal(values["pollIntervalSeconds"], 45);
});

test("pollIntervalSeconds 低于下限时拒绝保存", async () => {
  const { cookie, csrf } = await login();
  const body = configForm({
    keys: ["pollIntervalSeconds"],
    types: ["number"],
    values: ["5"],
    ops: ["keep"],
    csrf,
  });
  const res = await fetch(`${baseUrl}/admin/config/save`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body,
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /pollIntervalSeconds/);

  // 文件没被动过。
  const saved = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  assert.equal(saved["pollIntervalSeconds"], 45);
  assert.equal(saved["configVersion"], 4);
});

test("没有 CSRF 字段的提交被拒绝", async () => {
  const { cookie } = await login();
  const body = configForm({
    keys: ["pollIntervalSeconds"],
    types: ["number"],
    values: ["99"],
    ops: ["keep"],
    csrf: "伪造的",
  });
  const res = await fetch(`${baseUrl}/admin/config/save`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body,
  });
  assert.equal(res.status, 403);

  const saved = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  assert.equal(saved["pollIntervalSeconds"], 45);
});

test("可以回滚到历史备份，版本号继续往上走", async () => {
  const { cookie, csrf } = await login();
  const backups = readdirSync(backupDir);
  assert.ok(backups.length >= 1);

  const res = await fetch(`${baseUrl}/admin/config/restore`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, backup: backups[0]! }).toString(),
    redirect: "manual",
  });
  assert.equal(res.status, 303);

  const restored = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  // 内容回到备份时的样子。
  assert.equal(restored["pollIntervalSeconds"], 60);
  assert.deepEqual(restored["features"], { showGuide: true });
  // 版本号不回退 —— 客户端只认「变大」才刷新缓存。
  assert.equal(restored["configVersion"], 5);
});

test("回滚接口不接受目录穿越", async () => {
  const { cookie, csrf } = await login();
  const res = await fetch(`${baseUrl}/admin/config/restore`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, backup: "../../../etc/passwd" }).toString(),
  });
  assert.equal(res.status, 400);
});

test("后台配置文件不存在时不会崩", async () => {
  // 单独起一个指向不存在文件的 ConfigStore。
  const missing = resolve(configDir, "not-exist.json");
  const store = new ConfigStore(missing, { backupDir });
  const loaded = store.load();
  assert.deepEqual(loaded.values, {});
  assert.equal(existsSync(missing), false);
});

test("配置文件的排版规则与手写的一致（改一个字段只差一行）", () => {
  // 用仓库里真实的配置文件做基准：
  // 序列化器必须能把它原样写回去，否则每次在控制台改一个字段，
  // 版本库里都会出现一次全文件大改。
  const original = readFileSync("config/remote-config.json", "utf8");
  assert.equal(formatConfigJson(JSON.parse(original)), original);
});

test("改了配置之后，文件里只有那一个字段变了", async () => {
  const { cookie, csrf } = await login();
  const view = (await (await fetch(`${baseUrl}/admin/api/config`, { headers: { cookie } })).json()) as {
    values: Record<string, unknown>;
  };

  const keys = Object.keys(view.values);
  const types = keys.map((k) => (typeof view.values[k] === "number" ? "number" : "json"));
  const values = keys.map((k) =>
    typeof view.values[k] === "object" ? JSON.stringify(view.values[k]) : String(view.values[k]),
  );
  const idx = keys.indexOf("pollIntervalSeconds");
  assert.ok(idx >= 0, "测试配置里要有 pollIntervalSeconds");
  values[idx] = "45";

  const p = new URLSearchParams();
  p.set("keys", JSON.stringify(keys));
  types.forEach((t) => p.append("t", t));
  values.forEach((v) => p.append("v", v));
  keys.forEach(() => p.append("op", "keep"));
  p.set("csrf", csrf);
  p.set("action", "save");

  const before = readFileSync(configFile, "utf8");
  const res = await fetch(`${baseUrl}/admin/config/save`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: p.toString(),
    redirect: "manual",
  });
  assert.equal(res.status, 303);

  const after = readFileSync(configFile, "utf8");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const changed: number[] = [];
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i);
  }
  // 改一个字段，应该只有那一行和版本号那一行不同。
  assert.ok(changed.length <= 2, `只应有两行不同，实际 ${changed.length} 行：${changed.join(",")}`);
  assert.match(after, /"pollIntervalSeconds": 45/);
});
