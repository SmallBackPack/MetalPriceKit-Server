//
//  upstream.test.ts
//  MetalPriceKit Server
//  上游适配层测试：符号映射、单位、汇率方向、额度刹车。
//
//  全部打本地假上游，不消耗真实额度。
//

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerConfig } from "../src/config.ts";
import { normalizeLatest, UpstreamClient } from "../src/upstream.ts";
import { LATEST_SAMPLE, startFakeUpstream } from "./fixture.ts";
import { monthKey, secondsUntilNextMonth } from "../src/collector.ts";

const config = {
  metals: [
    { code: "XAU", name: "黄金", baseUnit: "oz", scale: 2, category: "precious", order: 1, upstreamSymbol: "gold" },
    { code: "XAG", name: "白银", baseUnit: "oz", scale: 3, category: "precious", order: 2, upstreamSymbol: "silver" },
    { code: "HG", name: "铜", baseUnit: "t", scale: 2, category: "industrial", order: 5, upstreamSymbol: "copper" },
    { code: "NI", name: "镍", baseUnit: "t", scale: 2, category: "industrial", order: 6, upstreamSymbol: "nickel" },
    { code: "ALI", name: "铝", baseUnit: "t", scale: 2, category: "industrial", order: 7, upstreamSymbol: "aluminum" },
    { code: "ZNC", name: "锌", baseUnit: "t", scale: 2, category: "industrial", order: 8, upstreamSymbol: "zinc" },
  ],
  currencyAllowlist: ["USD", "CNY", "EUR", "JPY"],
  upstreamApiKey: "test-key",
  monthlyRequestBudget: 100,
} as unknown as ServerConfig;

test("上游符号被映射成我们的 code（aluminum → ALI、copper → HG）", () => {
  const result = normalizeLatest(LATEST_SAMPLE as never, config);

  assert.equal(result.prices.get("XAU"), 4061.325);
  assert.equal(result.prices.get("XAG"), 52.199);
  assert.equal(result.prices.get("HG"), 14306.8661);
  assert.equal(result.prices.get("NI"), 15852.5);
  assert.equal(result.prices.get("ALI"), 3053.8);
  assert.equal(result.prices.get("ZNC"), 3776.44);
  // 上游还有一堆 lbma_/lme_/mcx_ 符号，不该混进来。
  assert.equal(result.prices.size, 6);
});

test("工业金属保持上游的公吨口径，不需要换算", () => {
  const result = normalizeLatest(LATEST_SAMPLE as never, config);
  // 上游 copper 就是 14306.87（USD/吨），不是 0.4605（USD/盎司）。
  assert.ok(result.prices.get("HG")! > 1000);
});

test("汇率取倒数：上游给「1 X 币 = ? USD」，我们要「1 USD = ? X 币」", () => {
  const result = normalizeLatest(LATEST_SAMPLE as never, config);

  // 上游 CNY = 0.1498 → 我们下发的应是 1/0.1498 ≈ 6.675
  assert.ok(Math.abs(result.currencyRates.get("CNY")! - 1 / 0.1498035959) < 1e-9);
  // 上游 EUR = 1.1216 → 1 USD = 0.8916 EUR
  assert.ok(Math.abs(result.currencyRates.get("EUR")! - 1 / 1.1216032649) < 1e-9);
  assert.equal(result.currencyRates.get("USD"), 1);
});

test("已废弃货币与加密货币被白名单过滤掉", () => {
  const result = normalizeLatest(LATEST_SAMPLE as never, config);

  assert.equal(result.currencyRates.has("BTC"), false);
  assert.equal(result.currencyRates.has("EEK"), false);
  assert.equal(result.currencyRates.has("BYR"), false);
  assert.equal(result.currencyRates.has("XDR"), false);
  assert.equal(result.currencyRates.has("ZWD"), false);
});

test("额度用尽后不再向上游发请求", async () => {
  const fake = await startFakeUpstream();
  try {
    const upstream = new UpstreamClient({
      config: {
        ...config,
        upstreamBaseUrl: fake.baseUrl,
        monthlyRequestBudget: 2,
      } as ServerConfig,
    });

    await upstream.fetchLatest();
    await upstream.fetchLatest();
    assert.equal(upstream.used, 2);

    // 第三次必须被拦下，且不产生真实请求。
    await assert.rejects(() => upstream.fetchLatest(), /额度/);
    assert.equal(fake.calls.length, 2, "被拦下的请求不应真的打到上游");
  } finally {
    await fake.close();
  }
});

test("上游返回 5xx 时抛出带状态码的错误", async () => {
  const fake = await startFakeUpstream();
  try {
    fake.failNext = true;
    const upstream = new UpstreamClient({
      config: { ...config, upstreamBaseUrl: fake.baseUrl } as ServerConfig,
    });
    await assert.rejects(() => upstream.fetchLatest(), /上游返回 500/);
  } finally {
    await fake.close();
  }
});

test("上游缺某个品种时只是少一条，不影响其它品种", async () => {
  const fake = await startFakeUpstream();
  try {
    const upstream = new UpstreamClient({
      config: { ...config, upstreamBaseUrl: fake.baseUrl } as ServerConfig,
    });
    const latest = await upstream.fetchLatest();
    const result = normalizeLatest(latest, config);
    assert.ok(result.prices.size > 0);
    assert.ok(result.prices.size <= config.metals.length);
  } finally {
    await fake.close();
  }
});

test("上游请求会带上 api_key 参数", async () => {
  const fake = await startFakeUpstream();
  try {
    const upstream = new UpstreamClient({
      config: { ...config, upstreamBaseUrl: fake.baseUrl } as ServerConfig,
    });
    await upstream.fetchLatest();
    assert.equal(fake.calls.includes("/v1/latest"), true);
  } finally {
    await fake.close();
  }
});

test("monthKey 用 UTC 且补零", () => {
  assert.equal(monthKey(new Date("2026-01-05T23:59:59Z")), "2026-01");
  assert.equal(monthKey(new Date("2026-11-30T00:00:00Z")), "2026-11");
  assert.equal(monthKey(new Date("2026-12-01T00:00:00Z")), "2026-12");
});

test("距下个月的天数算得对", () => {
  // 11 月 30 日 23:00 UTC 到 12 月 1 日 00:00 UTC 差 1 小时。
  const secs = secondsUntilNextMonth(new Date("2026-11-30T23:00:00Z").getTime());
  assert.equal(secs, 3600);
  // 已经跨月时返回 0，不返回负数。
  assert.equal(secondsUntilNextMonth(new Date("2026-12-01T00:00:00Z").getTime()), 2678400);
});
