//
//  market.test.ts
//  MetalPriceKit Server
//  行情语义测试：涨跌基准、市场状态、过期判定、单位与精度。
//
//  这些是「后端定义、客户端只显示」的部分，
//  逻辑错了客户端会显示错的数字，所以在服务端钉死。
//

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFxPayload,
  buildMetalsPayload,
  buildQuotesPayload,
  computeChange,
  inferMarketStatus,
  isStale,
  roundTo,
} from "../src/market.ts";
import type { ServerConfig } from "../src/config.ts";

const config = {
  metals: [
    { code: "XAU", name: "黄金", baseUnit: "oz", scale: 2, category: "precious", order: 1, upstreamSymbol: "gold" },
    { code: "HG", name: "铜", baseUnit: "t", scale: 2, category: "industrial", order: 5, upstreamSymbol: "copper" },
  ],
  pollIntervalMs: 600_000,
  marketHolidays: [] as string[],
} as unknown as ServerConfig;

const snapshot = {
  fetchedAt: "2026-11-04T10:00:00.000Z",
  metalAsOf: "2026-11-04T09:56:11.083Z",
  fxAsOf: "2026-11-04T09:58:11.590Z",
  prices: { XAU: 4061.325, HG: 14306.8661 },
  fx: { USD: 1, CNY: 6.6751 },
  hasPrevClose: true,
};

test("涨跌额 = 现价 − 前收盘；涨跌幅是小数不是百分数", () => {
  const { change, changeRate } = computeChange(4061.325, 3930.0);
  assert.equal(change, 131.325);
  // 0.033416 是原始小数，对应 3.34%，客户端自己乘 100 去渲染。
  assert.ok(Math.abs(changeRate - 131.325 / 3930.0) < 1e-12);
  assert.ok(changeRate > 0 && changeRate < 1);
});

test("没有前收盘基准时涨跌给 0，而不是 NaN 或 Infinity", () => {
  const { change, changeRate } = computeChange(4061.325, null);
  assert.equal(change, 0);
  assert.equal(changeRate, 0);
});

test("前收盘为 0 时不会除零", () => {
  const { change, changeRate } = computeChange(4061.325, 0);
  assert.equal(change, 0);
  assert.equal(changeRate, 0);
});

test("周末与周日判定为休市", () => {
  assert.equal(inferMarketStatus(new Date("2026-11-07T12:00:00Z")), "closed"); // 周六
  assert.equal(inferMarketStatus(new Date("2026-11-08T12:00:00Z")), "closed"); // 周日
});

test("周五伦敦时间 23:00 收市，周一 00:00 复市", () => {
  // 2026-11-06 是周五。英国冬令时（GMT+0），伦敦时间 = UTC。
  assert.equal(inferMarketStatus(new Date("2026-11-06T21:00:00Z")), "open");
  assert.equal(inferMarketStatus(new Date("2026-11-06T23:30:00Z")), "closed");
  // 2026-11-09 是周一
  assert.equal(inferMarketStatus(new Date("2026-11-09T00:00:00Z")), "open");
});

test("夏令时期间边界跟着伦敦时间走，不会整体漂移一小时", () => {
  // 2026-07-06 是周一。英国夏令时（GMT+1），伦敦时间 = UTC+1。
  assert.equal(inferMarketStatus(new Date("2026-07-06T00:00:00Z")), "open"); // 伦敦周一 01:00
  // 2026-07-10 是周五。伦敦 23:30 = UTC 22:30
  assert.equal(inferMarketStatus(new Date("2026-07-10T22:30:00Z")), "closed");
  assert.equal(inferMarketStatus(new Date("2026-07-10T21:30:00Z")), "open"); // 伦敦 22:30
});

test("节假日判定为休市，非节假日照常开市", () => {
  const holidays = ["2026-12-25", "2026-01-01"];
  // 2026-12-25 是周五
  assert.equal(inferMarketStatus(new Date("2026-12-25T10:00:00Z"), holidays), "closed");
  // 2026-12-24 是周四
  assert.equal(inferMarketStatus(new Date("2026-12-24T10:00:00Z"), holidays), "open");
});

test("休市时不算过期 —— 行情冻结是正常的", () => {
  const oldFetch = "2026-11-07T10:00:00.000Z";
  const now = new Date("2026-11-08T10:00:00.000Z"); // 隔了一天，周日
  assert.equal(isStale(oldFetch, "closed", now, 30 * 60 * 1000), false);
});

test("开市时超过阈值算过期 —— 说明采集器卡住了", () => {
  const oldFetch = "2026-11-04T10:00:00.000Z";
  const now = new Date("2026-11-04T11:00:00.000Z");
  assert.equal(isStale(oldFetch, "open", now, 30 * 60 * 1000), true);
  assert.equal(isStale(oldFetch, "open", now, 2 * 60 * 60 * 1000), false);
});

test("价格未变（周末冻结）时沿用上一交易日的涨跌幅", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  // 现价与前收盘完全相同 → 行情冻结
  const prevCloses = new Map([["XAU", 4061.325]]);
  const prevChanges = new Map([["XAU", { change: 131.325, changeRate: 0.033416 }]]);

  const payload = buildQuotesPayload(config, snapshot, prevCloses, prevChanges, now);
  const xau = payload.quotes.find((q) => q.code === "XAU")!;

  // 不是 0 —— 沿用周五算出的涨跌幅
  assert.equal(xau.change, 131.33);
  assert.ok(Math.abs(xau.changeRate - 0.033416) < 1e-6);
});

test("价格变动时用新价格计算涨跌幅，不沿用旧值", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const prevCloses = new Map([["XAU", 3930.0]]);
  const prevChanges = new Map([["XAU", { change: 999, changeRate: 9 }]]);

  const payload = buildQuotesPayload(config, snapshot, prevCloses, prevChanges, now);
  const xau = payload.quotes.find((q) => q.code === "XAU")!;

  assert.equal(xau.change, 131.33);
  assert.ok(xau.changeRate < 1, "不应沿用旧涨跌幅");
});

test("价格按品种 scale 舍入，不下发浮点噪声", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const payload = buildQuotesPayload(config, snapshot, new Map(), new Map(), now);
  const hg = payload.quotes.find((q) => q.code === "HG")!;

  // 上游原值 14306.8661，scale=2 → 14306.87
  assert.equal(hg.price, 14306.87);
  assert.equal(String(hg.price).length <= 9, true);
});

test("roundTo 对负数同样正确", () => {
  assert.equal(roundTo(-32.5049, 2), -32.5);
  assert.equal(roundTo(2.345, 2), 2.35);
  assert.equal(roundTo(1.005, 2), 1.01);
});

test("quotes 里的价格与 baseUnit 成对下发", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const payload = buildQuotesPayload(config, snapshot, new Map(), new Map(), now);
  const xau = payload.quotes.find((q) => q.code === "XAU")!;
  const hg = payload.quotes.find((q) => q.code === "HG")!;

  assert.equal(xau.baseUnit, "oz");
  assert.equal(hg.baseUnit, "t");
  assert.equal(xau.currency, "USD");
});

test("缺少价格的品种不出现在 quotes 里（失败要响，不要塞 0）", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const partial = { ...snapshot, prices: { XAU: 4061.325 } };
  const payload = buildQuotesPayload(config, partial, new Map(), new Map(), now);

  assert.equal(payload.quotes.length, 1);
  assert.equal(payload.quotes[0]!.code, "XAU");
  assert.equal(
    payload.quotes.some((q) => q.code === "HG"),
    false,
  );
});

test("品种字典带出 scale 与 baseUnit，客户端不用本地硬编码", () => {
  const payload = buildMetalsPayload(config, new Date("2026-11-04T12:00:00Z"));
  assert.equal(payload.metals.length, 2);
  assert.equal(payload.metals[0]!.code, "XAU");
  assert.equal(payload.metals[0]!.scale, 2);
  assert.equal(payload.metals[0]!.baseUnit, "oz");
});

test("汇率表声明 base=USD，方向是「1 USD = rates[X] 个 X 币」", () => {
  const payload = buildFxPayload(snapshot, new Date("2026-11-04T12:00:00Z"));
  assert.equal(payload.base, "USD");
  assert.equal(payload.rates["USD"], 1);
  // 上游给的是 1 CNY = 0.1498 USD，取倒数后是 1 USD = 6.67 CNY。
  assert.ok(payload.rates["CNY"]! > 6 && payload.rates["CNY"]! < 7);
});
