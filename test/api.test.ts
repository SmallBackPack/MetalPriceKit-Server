//
//  api.test.ts
//  MetalPriceKit Server
//  端到端接口测试：真实 HTTP 收发 + 真实加解密。
//
//  走的是完整的 Express 应用（假上游 + 内存 SQLite），
//  验证客户端实际会经历的事情：
//  - 路径是混淆过的，语义路径返回 404
//  - 带客户端公钥时响应是密文，能解开且结构与契约一致
//  - ETag 命中返回 304
//  - 401 / 404 / 429 等状态码行为正确
//

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import { createApp } from "../src/app.ts";
import { Collector } from "../src/collector.ts";
import { Store } from "../src/store.ts";
import { UserStore } from "../src/userstore.ts";
import { ConfigStore } from "../src/configstore.ts";
import { UpstreamClient } from "../src/upstream.ts";
import { deriveSessionKey, open, publicOf, buildAad, seal } from "../src/crypto.ts";
import { startFakeUpstream, LATEST_SAMPLE } from "./fixture.ts";
import type { FakeUpstream } from "./fixture.ts";
import type { ServerConfig } from "../src/config.ts";

let fake: FakeUpstream;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl: string;

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
  upstreamApiKey: "test-key",
  upstreamBaseUrl: "",
  pollIntervalMs: 600_000,
  monthlyRequestBudget: 100,
  serverKeys: [],
  activeKid: "k1",
  metals: [
    { code: "XAU", name: "黄金", baseUnit: "oz", scale: 2, category: "precious", order: 1, upstreamSymbol: "gold" },
    { code: "HG", name: "铜", baseUnit: "t", scale: 2, category: "industrial", order: 5, upstreamSymbol: "copper" },
  ],
  routes,
  currencyAllowlist: ["USD", "CNY"],
  marketHolidays: [] as string[],
  fetchOnBoot: true,
  dataDir: "data",
} as unknown as ServerConfig;

// 服务端密钥对
const serverPrivate = randomBytes(32);
(config.serverKeys as unknown[]).push({
  kid: "k1",
  privateKey: serverPrivate,
  publicKey: publicOf(serverPrivate),
});

// 客户端密钥对（模拟 App）
const clientKp = generateKeyPairSync("x25519");
const clientPubDer = clientKp.publicKey.export({ format: "der", type: "spki" });
const clientPublic = clientPubDer.subarray(clientPubDer.length - 32);
const clientPubB64 = clientPublic.toString("base64");

/** 客户端侧派生密钥 —— 与服务端 crypto.ts 同一套算法。 */
function clientSessionKey(direction: "request" | "response"): Buffer {
  const SPKI = Buffer.from("302a300506032b656e032100", "hex");
  const shared = diffieHellman({
    privateKey: clientKp.privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([SPKI, publicOf(serverPrivate)]),
      format: "der",
      type: "spki",
    }),
  });
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from("metalpricekit/v1", "utf8"),
      Buffer.from(`metalpricekit/v1/${direction}`, "utf8"),
      32,
    ),
  );
}

/** 带客户端公钥发请求，并解开响应。 */
async function callEncrypted(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; data: any }> {
  const headers = new Headers(init.headers);
  headers.set("x-mpk-ck", clientPubB64);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  if (res.status === 204) return { status: res.status, headers: res.headers, data: null };
  if (!text) return { status: res.status, headers: res.headers, data: null };
  const parsed = JSON.parse(text);
  if (res.headers.get("x-mpk-encrypted") === "1") {
    const aad = buildAad(init.method ?? "GET", path, parsed.kid);
    const plaintext = open(parsed, clientSessionKey("response"), aad);
    return { status: res.status, headers: res.headers, data: JSON.parse(plaintext) };
  }
  return { status: res.status, headers: res.headers, data: parsed };
}

before(async () => {
  fake = await startFakeUpstream();
  (config as { upstreamBaseUrl: string }).upstreamBaseUrl = fake.baseUrl;

  const marketDb = new DatabaseSync(":memory:");
  const userDb = new DatabaseSync(":memory:");
  const store = new Store(marketDb);
  const users = new UserStore(userDb);
  UserStore.migrate(userDb);

  const upstream = new UpstreamClient({ config });
  const collector = new Collector({ config, store, upstream, log: () => {} });
  const genericConfig = new ConfigStore("config/remote-config.json");

  const app = createApp({ config, collector, store, users, genericConfig });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  await collector.start();
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fake.close();
});

test("bootstrap 返回服务端公钥，明文", async () => {
  const res = await fetch(`${baseUrl}${routes.bootstrap}`);
  const body = (await res.json()) as {
    v: number;
    keys: { kid: string; publicKey: string }[];
  };

  assert.equal(res.status, 200);
  assert.equal(body.v, 1);
  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0]!.kid, "k1");
  assert.equal(Buffer.from(body.keys[0]!.publicKey, "base64").length, 32);
});

test("语义路径不会被暴露：/v1/quotes 返回 404", async () => {
  const res = await fetch(`${baseUrl}/v1/quotes`);
  assert.equal(res.status, 404);
});

test("行情接口返回密文，解开后结构与契约一致", async () => {
  const { status, headers, data } = await callEncrypted(routes.quotes);

  assert.equal(status, 200);
  assert.equal(headers.get("x-mpk-encrypted"), "1");
  assert.equal(headers.get("x-mpk-kid"), "k1");
  assert.ok(headers.get("x-request-id"), "应有请求追踪 ID");

  assert.ok(data.serverTime);
  assert.ok(["open", "closed"].includes(data.marketStatus));
  assert.equal(data.changeBasis, "prevClose");
  assert.equal(Array.isArray(data.quotes), true);
  assert.equal(data.quotes.length, 2);

  const xau = data.quotes.find((q: any) => q.code === "XAU");
  assert.equal(xau.price, 4061.33); // scale=2
  assert.equal(xau.baseUnit, "oz");
  assert.equal(xau.currency, "USD");
  assert.equal(typeof xau.changeRate, "number");
  assert.equal(typeof xau.isStale, "boolean");
});

test("原始响应体里看不到明文价格", async () => {
  const res = await fetch(`${baseUrl}${routes.quotes}`, {
    headers: { "x-mpk-ck": clientPubB64 },
  });
  const raw = await res.text();

  assert.equal(raw.includes("4061"), false, "响应体不应包含明文价格");
  assert.equal(raw.includes("XAU"), false, "响应体不应包含明文品种代码");
});

test("品种字典接口下发 scale 与 baseUnit", async () => {
  const { status, data } = await callEncrypted(routes.metals);

  assert.equal(status, 200);
  assert.equal(data.metals.length, 2);
  assert.equal(data.metals[0].code, "XAU");
  assert.equal(data.metals[0].scale, 2);
  assert.equal(data.metals[0].baseUnit, "oz");
});

test("汇率接口方向是「1 USD = rates[X]」", async () => {
  const { status, data } = await callEncrypted(routes.fx);

  assert.equal(status, 200);
  assert.equal(data.base, "USD");
  assert.equal(data.rates.USD, 1);
  assert.ok(data.rates.CNY > 6 && data.rates.CNY < 7);
});

test("通用字段接口返回任意 key 的字典", async () => {
  const { status, data } = await callEncrypted(routes.fields);

  assert.equal(status, 200);
  assert.equal(typeof data, "object");
  assert.ok(!Array.isArray(data));
  // 来自 config/remote-config.json
  assert.equal(data.pollIntervalSeconds, 15);
  assert.equal(typeof data.features, "object");
  // configVersion 是元信息，不应作为普通字段下发
  assert.equal(data.configVersion, undefined);
});

test("结构化配置接口仍然可用，且值来自通用配置文件而不是代码里的副本", async () => {
  const { status, data } = await callEncrypted(routes.config);

  assert.equal(status, 200);
  assert.ok(data.configVersion);
  assert.ok(data.features);
  assert.ok(data.runtime.pollIntervalSeconds > 0);
  // 客户端轮询间隔取自 remote-config.json（15 秒），不是上游刷新间隔
  assert.equal(data.runtime.pollIntervalSeconds, 15);
  // 上游刷新间隔另起字段，客户端据此判断数据有多旧
  assert.equal(data.runtime.upstreamRefreshSeconds, 600);
  // features / marketing 来自同一份配置文件，值一致
  assert.equal(data.features.showGuide, true);
  assert.equal(data.marketing.noticeTitle, "行情数据说明");
});

test("ETag 命中返回 304 且无 body", async () => {
  const first = await callEncrypted(routes.metals);
  const etag = first.headers.get("etag");
  assert.ok(etag);

  const res = await fetch(`${baseUrl}${routes.metals}`, {
    headers: { "x-mpk-ck": clientPubB64, "if-none-match": etag! },
  });

  assert.equal(res.status, 304);
  assert.equal((await res.text()).length, 0);
});

test("匿名注册：同一 deviceId 幂等，返回同一个 userId", async () => {
  const body = JSON.stringify({ deviceId: "device-abc-123", appVersion: "1.0.0" });

  const first = await callEncrypted(routes.auth, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.isNewUser, true);
  assert.ok(first.data.token);
  assert.equal(first.data.token.length, 64);

  const second = await callEncrypted(routes.auth, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.isNewUser, false);
  assert.equal(second.data.userId, first.data.userId);
  // 每次签发新 token，但旧 token 不吊销
  assert.notEqual(second.data.token, first.data.token);
});

test("请求体也可以加密提交", async () => {
  const payload = JSON.stringify({ deviceId: "device-encrypted-999" });
  const path = routes.auth;
  const envelope = seal(payload, clientSessionKey("request"), "k1", buildAad("POST", path, "k1"));

  const { status, data } = await callEncrypted(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });

  assert.equal(status, 200);
  assert.ok(data.userId);
});

test("没有 token 访问用户资料返回 401", async () => {
  const res = await fetch(`${baseUrl}${routes.profile}`);
  assert.equal(res.status, 401);
});

test("带 token 可以读写用户资料", async () => {
  const auth = await callEncrypted(routes.auth, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "device-profile-1" }),
  });
  const token = auth.data.token;

  const profile = await callEncrypted(routes.profile, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.userId, auth.data.userId);

  const patched = await callEncrypted(routes.profile, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ nickname: "老王", settings: { currency: "USD" } }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.nickname, "老王");
  assert.equal(patched.data.settings.currency, "USD");
});

test("反馈接口需要 token，缺 token 返回 401", async () => {
  const { status } = await callEncrypted(routes.feedback, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ category: "bug", content: "铜价在凌晨显示为 0" }),
  });

  assert.equal(status, 401);
});

test("反馈接口返回 201 与工单号", async () => {
  const auth = await callEncrypted(routes.auth, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "device-feedback-1" }),
  });

  const { status, data } = await callEncrypted(routes.feedback, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth.data.token}` },
    body: JSON.stringify({ category: "bug", content: "铜价在凌晨显示为 0" }),
  });

  assert.equal(status, 201);
  assert.ok(data.ticketId.startsWith("fb_"));
});

test("埋点接口需要 token，缺 token 返回 401", async () => {
  const res = await fetch(`${baseUrl}${routes.events}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mpk-ck": clientPubB64 },
    body: JSON.stringify({ sessionId: "s_1", events: [{ name: "price_list_view" }] }),
  });

  assert.equal(res.status, 401);
});

test("崩溃上报返回 204", async () => {
  const res = await fetch(`${baseUrl}${routes.crash}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mpk-ck": clientPubB64 },
    body: JSON.stringify({ signal: "SIGSEGV", reason: "Index 5 beyond bounds" }),
  });
  assert.equal(res.status, 204);
});

test("health 不暴露供应商与配额明细", async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = (await res.json()) as Record<string, unknown>;

  assert.equal(res.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptimeSeconds, "number");
  // 契约明确要求：不返回供应商名称和配额明细
  assert.equal(body.plan, undefined);
  assert.equal(body.remaining, undefined);
  assert.equal(body.apiKey, undefined);
});

test("没有客户端公钥就拿不到明文数据", async () => {
  const res = await fetch(`${baseUrl}${routes.quotes}`);

  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "client_key_required");
});

test("畸形客户端公钥不会把服务打成 500", async () => {
  // 长度对但不是有效的 X25519 点（全零），OpenSSL 会拒绝派生密钥。
  const res = await fetch(`${baseUrl}${routes.quotes}`, {
    headers: { "x-mpk-ck": Buffer.alloc(32).toString("base64") },
  });

  assert.equal(res.status, 400);
});

test("采集确实打到了上游一次（只用了 1 次额度）", () => {
  assert.equal(fake.calls.filter((c) => c === "/v1/latest").length, 1);
});
