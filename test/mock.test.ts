//
//  mock.test.ts
//  MetalPriceKit Server
//  假数据模式的测试。
//
//  重点验证三件事：
//  1. 假数据模式下不消耗任何额度
//  2. 假数据的形状与真实上游一致（归一化、汇率取倒数那条链路要真跑到）
//  3. 假数据能被一眼认出来（响应头 + dataSource）
//

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { createApp } from "../src/app.ts";
import { Collector } from "../src/collector.ts";
import { MockUpstreamClient } from "../src/mock.ts";
import { Store } from "../src/store.ts";
import { UserStore } from "../src/userstore.ts";
import { ConfigStore } from "../src/configstore.ts";
import { normalizeLatest } from "../src/upstream.ts";
import { buildAad, open, publicOf } from "../src/crypto.ts";
import type { ServerConfig } from "../src/config.ts";

const config = {
  port: 0,
  host: "127.0.0.1",
  upstreamApiKey: "",
  upstreamBaseUrl: "",
  pollIntervalMs: 15_000,
  monthlyRequestBudget: 100,
  serverKeys: [] as { kid: string; privateKey: Buffer; publicKey: Buffer }[],
  activeKid: "k1",
  metals: [
    { code: "XAU", name: "黄金", baseUnit: "oz", scale: 2, category: "precious", order: 1, upstreamSymbol: "gold" },
    { code: "HG", name: "铜", baseUnit: "t", scale: 2, category: "industrial", order: 5, upstreamSymbol: "copper" },
  ],
  routes: {
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
  },
  currencyAllowlist: ["USD", "CNY", "EUR", "JPY"],
  marketHolidays: [] as string[],
  fetchOnBoot: true,
  mockMode: true,
  dataDir: "data",
} as unknown as ServerConfig;

test("假数据模式不消耗任何额度", async () => {
  const upstream = new MockUpstreamClient({ config });
  assert.equal(upstream.used, 0);

  await upstream.fetchLatest();
  await upstream.fetchLatest();
  await upstream.fetchLatest();
  assert.equal(upstream.used, 0, "假数据不该扣额度");
});

test("假数据的形状与真实上游一致，归一化那条链路真跑到了", async () => {
  const upstream = new MockUpstreamClient({ config });
  const latest = await upstream.fetchLatest();

  // 符号用的是上游的名字（gold / copper…），不是我们的 code
  assert.ok(typeof latest.metals["gold"] === "number");
  assert.ok(typeof latest.metals["copper"] === "number");
  assert.equal(latest.currency, "USD");
  assert.equal(latest.unit, "default");

  // 上游给的是「1 X 币 = ? USD」，归一化后才是「1 USD = ? X 币」
  const normalized = normalizeLatest(latest, config);
  assert.ok(normalized.prices.get("XAU")! > 1000, "黄金量级不对");
  assert.ok(normalized.prices.get("HG")! > 1000, "铜的量级不对（公吨口径）");
  assert.ok(normalized.currencyRates.get("CNY")! > 6 && normalized.currencyRates.get("CNY")! < 7);
  assert.equal(normalized.currencyRates.get("USD"), 1);
});

test("假数据的价格会随轮次变化 —— 客户端要能看到价格在动", async () => {
  const upstream = new MockUpstreamClient({ config });
  const first = await upstream.fetchLatest();
  let changed = false;
  for (let i = 0; i < 5; i++) {
    const next = await upstream.fetchLatest();
    if (next.metals["gold"] !== first.metals["gold"]) changed = true;
  }
  assert.equal(changed, true, "多轮之后价格应该变了");
});

test("假数据模式不踩额度刹车：间隔就是配置值", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(db);
  const upstream = new MockUpstreamClient({ config });
  const collector = new Collector({ config, store, upstream, log: () => {} });

  // 配置 15 秒 —— 有额度刹车的话会被拉到几小时
  assert.equal(collector.nextIntervalMs(), 15_000);
});

test("播种后涨跌额不是 0 —— 否则客户端测不了涨跌显示", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(db);
  const upstream = new MockUpstreamClient({ config });
  const collector = new Collector({ config, store, upstream, log: () => {} });

  await collector.collectOnce();

  const codes = config.metals.map((m) => m.code);
  const tradeDate = new Date().toISOString().slice(0, 10);
  const prevCloses = store.prevCloseMap(codes, tradeDate);
  assert.ok(prevCloses.size > 0, "应该播种了上一交易日的基准价");

  const snapshot = collector.currentSnapshot!;
  const changes = snapshot.prices["XAU"]! - prevCloses.get("XAU")!;
  assert.ok(changes !== 0, "现价与基准价应该不同，涨跌额才有意义");
});

// ── 接口层：假数据必须能被一眼认出来 ──────────────────────────

// 服务端密钥对（与 api.test.ts 同一套做法）
const serverPrivate = randomBytes(32);
config.serverKeys.push({ kid: "k1", privateKey: serverPrivate, publicKey: publicOf(serverPrivate) });

// 客户端密钥对
const clientKp = generateKeyPairSync("x25519");
const clientPubDer = clientKp.publicKey.export({ format: "der", type: "spki" });
const clientPubB64 = clientPubDer.subarray(clientPubDer.length - 32).toString("base64");

/** 客户端侧派生会话密钥 —— 与服务端 crypto.ts 同一套算法。 */
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

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let baseUrl: string;

before(async () => {
  const marketDb = new DatabaseSync(":memory:");
  const userDb = new DatabaseSync(":memory:");
  const store = new Store(marketDb);
  const users = new UserStore(userDb, { pepper: "test-pepper" });
  const upstream = new MockUpstreamClient({ config });
  const collector = new Collector({ config, store, upstream, log: () => {} });
  const genericConfig = new ConfigStore("config/remote-config.json", {
    backupDir: resolve(tmpdir(), "mpk-test-backups"),
  });

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
});

test("假数据模式的每个响应都带 X-MPK-Mock 头", async () => {
  // 不带客户端公钥 → 400，但标记依然要在（排查时要知道这台服务给的是假数据）
  const res = await fetch(`${baseUrl}${config.routes.quotes}`);

  assert.equal(res.status, 400);
  assert.equal(res.headers.get("x-mpk-mock"), "1");
});

test("假数据模式的响应带 dataSource 标记，解开后结构照常", async () => {
  const path = config.routes.quotes;
  const res = await fetch(`${baseUrl}${path}`, { headers: { "x-mpk-ck": clientPubB64 } });
  assert.equal(res.status, 200);

  const envelope = JSON.parse(await res.text());
  const aad = buildAad("GET", path, envelope.kid);
  const payload = JSON.parse(open(envelope, clientSessionKey("response"), aad));

  assert.equal(payload.dataSource, "mock");
  assert.equal(payload.quotes.length, 2);
  // 涨跌额不是 0 —— 播了基准价
  assert.ok(payload.quotes[0].change !== 0, "涨跌额应该有值");
  assert.ok(payload.quotes[0].price > 0);
});
