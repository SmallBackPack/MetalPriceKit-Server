//
//  market.ts
//  MetalPriceKit Server
//  把上游快照翻译成对客户端的契约结构。纯函数，不碰网络与数据库。
//
//  这一层集中回答「涨跌基准是什么」和「这条数据算不算过期」两个问题 ——
//  契约里都要求服务端定义，客户端只负责显示，所以判定必须收敛在这里。
//
//  涨跌基准（changeBasis）：
//  上游 /v1/latest 只给价格不给涨跌，逐个品种调 /v1/metal/spot 拿官方昨收要 8 次请求。
//  免费档一个月只有 100 次请求（实测：每次调用扣 1，/usage 查询不扣），
//  按 10 分钟一轮算要 4320 次/月，根本用不起。
//  所以基准改用「服务端自己观测到的上一交易日收盘价」：
//  每天把当天最后一次观测到的价格存成当日收盘，涨跌 = 现价 − 上一交易日收盘。
//
//  冻结语义（重要）：
//  周末与假期行情冻结，价格与上一交易日收盘完全相同。若照直算，涨跌恒为 0，
//  客户端会显示「0.00%」，用户会以为 App 坏了（契约文档里点名了这个坑）。
//  所以这里检测到「价格没动」时，沿用上一交易日算出的涨跌额 ——
//  也就是周六日显示的是周五那天的涨跌幅，符合行情 App 的常规做法。
//

import type { ServerConfig } from "./config.ts";
import type { SnapshotRecord } from "./store.ts";
import { tradeDateOf } from "./store.ts";

export type MarketStatus = "open" | "closed";

export interface Quote {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  currency: "USD";
  baseUnit: string;
  scale: number;
  asOf: string;
  isStale: boolean;
}

export interface QuotesPayload {
  serverTime: string;
  marketStatus: MarketStatus;
  changeBasis: "prevClose";
  quotes: Quote[];
}

export interface MetalsPayload {
  serverTime: string;
  metals: {
    code: string;
    name: string;
    baseUnit: string;
    scale: number;
    category: string;
    order: number;
  }[];
}

export interface FxPayload {
  serverTime: string;
  base: "USD";
  asOf: string;
  rates: Record<string, number>;
}

/**
 * 市场是否处于交易时段。
 *
 * 上游不提供交易状态，按上游适配层文档的初版规则推断：
 *  - 周六 / 周日 → closed
 *  - 周一 00:00–07:00 UTC（伦敦盘前）→ closed
 *  - 其余 → open
 *
 * ⚠️ 这套规则没有处理法定节假日，夏令时切换也会让 UTC 边界漂移。
 * 拿到足够真实数据后需要校准；在此之前保持宽松（宁可判 open），
 * 因为把 open 判成 closed 会让客户端显示错误的「休市」提示。
 */
export function inferMarketStatus(now: Date = new Date()): MarketStatus {
  const dow = now.getUTCDay();
  const hour = now.getUTCHours();
  if (dow === 0 || dow === 6) return "closed";
  if (dow === 1 && hour < 7) return "closed";
  return "open";
}

/**
 * 判断快照是否已过期。
 *
 * 注意这里用的是「我们上次成功抓取的时间」，不是上游数据自己的时间戳。
 * 因为免费档下轮询间隔必然以小时计（一个月 100 次请求），
 * 若按上游时间戳 + 30 分钟判定，客户端会看到所有品种永远都是过期态，
 * 那个信号就没有意义了。
 *
 * 过期 = 市场开着、但我们已经很长时间没抓到新数据 → 说明采集器出问题了，
 * 这正是需要提示用户「数据可能不准」的场景。
 */
export function isStale(
  snapshotFetchedAt: string,
  marketStatus: MarketStatus,
  now: Date = new Date(),
  stalenessThresholdMs: number,
): boolean {
  if (marketStatus === "closed") return false;
  const age = now.getTime() - new Date(snapshotFetchedAt).getTime();
  return age > stalenessThresholdMs;
}

/**
 * 按 scale 四舍五入，避免下发 14,306.866100000001 这种浮点噪声。
 *
 * 不能直接 Math.round(value * 10 ** scale)：IEEE754 下 1.005 * 100 是
 * 100.49999999999999，四舍五入会得到 1.00 而不是 1.01。
 * 先用指数写法把小数点挪到末尾（'1.005e2' 精确等于 100.5）再取整，绕开这个误差。
 */
export function roundTo(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value;
  const shifted = Number(`${value}e${scale}`);
  if (!Number.isFinite(shifted)) {
    // 极端量级下指数写法会溢出（'1e21e2' 非法），退回普通写法。
    const factor = 10 ** scale;
    return Math.round(value * factor) / factor;
  }
  // Math.round 对 .5 是「向 +∞ 取整」，负数要手动按「远离零」取整，
  // 否则 -1.005 会变成 -1.00 而 +1.005 变成 1.01，两边不对称。
  const magnitude = Math.round(Math.abs(shifted));
  const rounded = shifted < 0 ? -magnitude : magnitude;
  return Number(`${rounded}e${-scale}`);
}

/**
 * 原始涨跌幅的有效小数位。
 *
 * 上游价格最多 4 位小数，两个这样的价格相减，有效精度不会超过 4 位。
 * 收敛到 6 位：既抹平 IEEE754 的表示误差（4061.325 − 3930 = 131.32499999999982），
 * 又不会丢掉真实精度。
 */
const CHANGE_PRECISION = 6;

/**
 * 由「当前价」与「上一交易日收盘价」算出涨跌额与涨跌幅。
 *
 * changeRate 是原始小数（0.00707 = 0.707%），不乘 100，也不下发格式化字符串 ——
 * 客户端 MKFormatter.percent() 负责渲染。
 */
export function computeChange(
  price: number,
  prevClose: number | null,
): { change: number; changeRate: number } {
  if (prevClose === null || prevClose === 0) return { change: 0, changeRate: 0 };
  // 先把差值收敛到有效精度，再拿它算涨跌幅 ——
  // 用未收敛的差值会让 changeRate 带上一串浮点尾巴。
  const change = roundTo(price - prevClose, CHANGE_PRECISION);
  return { change, changeRate: change / prevClose };
}

/**
 * 组装 /quotes 响应。
 *
 * prevCloses 由调用方从 daily_close 表取好，key 是品种 code。
 * prevChanges 是上一交易日算出的涨跌额，用于「价格没动时沿用上一日涨跌幅」。
 */
export function buildQuotesPayload(
  config: ServerConfig,
  snapshot: SnapshotRecord,
  prevCloses: Map<string, number>,
  prevChanges: Map<string, { change: number; changeRate: number }>,
  now: Date = new Date(),
): QuotesPayload {
  const marketStatus = inferMarketStatus(now);
  const stalenessThresholdMs = Math.max(30 * 60 * 1000, config.pollIntervalMs * 2);
  const stale = isStale(snapshot.fetchedAt, marketStatus, now, stalenessThresholdMs);

  const quotes: Quote[] = [];
  for (const metal of config.metals) {
    const price = snapshot.prices[metal.code];
    if (typeof price !== "number" || !Number.isFinite(price)) continue;

    const prevClose = prevCloses.get(metal.code) ?? null;
    let change = computeChange(price, prevClose);

    // 价格与上一交易日收盘完全一致 → 行情冻结（周末 / 假期）。
    // 此时沿用上一交易日的涨跌幅，避免客户端显示 0.00% 被误认为故障。
    if (prevClose !== null && price === prevClose) {
      const carried = prevChanges.get(metal.code);
      if (carried) change = carried;
    }

    quotes.push({
      code: metal.code,
      name: metal.name,
      price: roundTo(price, metal.scale),
      change: roundTo(change.change, metal.scale),
      changeRate: Number(change.changeRate.toFixed(6)),
      currency: "USD",
      baseUnit: metal.baseUnit,
      scale: metal.scale,
      asOf: snapshot.metalAsOf,
      isStale: stale,
    });
  }

  return {
    serverTime: now.toISOString(),
    marketStatus,
    changeBasis: "prevClose",
    quotes,
  };
}

/** 组装 /metals 响应：品种字典。客户端据此取 scale 与 baseUnit，不再本地硬编码。 */
export function buildMetalsPayload(
  config: ServerConfig,
  now: Date = new Date(),
): MetalsPayload {
  return {
    serverTime: now.toISOString(),
    metals: config.metals.map((m) => ({
      code: m.code,
      name: m.name,
      baseUnit: m.baseUnit,
      scale: m.scale,
      category: m.category,
      order: m.order,
    })),
  };
}

/** 组装 /fx 响应：汇率表。语义是「1 USD = rates[X] 个 X 币」。 */
export function buildFxPayload(snapshot: SnapshotRecord, now: Date = new Date()): FxPayload {
  return {
    serverTime: now.toISOString(),
    base: "USD",
    asOf: snapshot.fxAsOf,
    rates: snapshot.fx,
  };
}
