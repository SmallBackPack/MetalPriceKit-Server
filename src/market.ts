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
import { roundTo } from "./num.ts";

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
  /**
   * 数据来源。`mock` = 假数据（客户端联调模式），`live` = 真实上游。
   *
   * 为什么要显式告诉客户端：假数据长得跟真数据一模一样，
   * 万一联调用的 App 被误当成正式版发出去，得能一眼认出来。
   */
  dataSource: "live" | "mock";
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
 * 伦敦时区的当前时间（星期几、小时、日期）。
 *
 * 金属现货的参照时区是伦敦（LBMA）。
 * 用固定的 UTC 边界会在夏令时切换时漂移一小时（伦敦 ↔ UTC 差 0 或 1 小时），
 * 所以直接取伦敦本地时间，让「周五收市、周一开市」自动对上。
 */
function londonNow(now: Date): { dow: number; hour: number; ymd: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  // hour12: false 在部分 ICU 版本里午夜会输出 "24"，归一到 0。
  const hour = Number.parseInt(get("hour"), 10) % 24;
  // 从「伦敦本地日期」直接取星期：把它当成 UTC 日期来算，结果就是伦敦那天的星期。
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return { dow, hour, ymd };
}

/**
 * 市场是否处于交易时段。
 *
 * 上游不提供交易状态，按金属现货的实际作息推断：
 *  - 伦敦时间周六 / 周日 → closed
 *  - 伦敦时间周五 23:00 起收市 → closed（一直闭到周一 00:00）
 *  - 命中 config/holidays.json 里的休市日 → closed
 *  - 其余 → open
 *
 * 为什么只判「有把握的休市」：
 * 把开市判成休市，会让用户以为价格不动、错过真正的行情；
 * 反过来只是客户端少一个「休市」提示，而涨跌额沿用上一交易日已经兜住了那个坑。
 * 两害相权，宁可判 open。
 *
 * ⚠️ 这套规则是按 LBMA 现货作息推的，没有处理各交易所的差异
 *    （COMEX 的收盘时间与 LBMA 差几个小时，夏令时也会让边界漂移）。
 *    拿到足够多的真实周末数据后需要校准。
 */
export function inferMarketStatus(
  now: Date = new Date(),
  holidays: readonly string[] = [],
): MarketStatus {
  const { dow, hour, ymd } = londonNow(now);
  if (holidays.includes(ymd)) return "closed";
  if (dow === 0 || dow === 6) return "closed";
  if (dow === 5 && hour >= 23) return "closed";
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
 * 原始涨跌幅的有效小数位。
 *
 * 上游价格最多 4 位小数，两个这样的价格相减，有效精度不会超过 4 位。
 * 收敛到 6 位：既抹平 IEEE754 的表示误差（4061.325 − 3930 = 131.32499999999982），
 * 又不会丢掉真实精度。
 */
const CHANGE_PRECISION = 6;

/**
 * 汇率下发的小数位。
 *
 * 上游给的是「1 X 币 = ? USD」，取倒数之后必然带一串浮点尾巴
 * （1/0.2725 = 3.6725000000514147）。8 位小数已经远超汇率的实际需要，
 * 下发干净数字，客户端格式化时也不会出现一串 0。
 */
const FX_RATE_PRECISION = 8;

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
  const marketStatus = inferMarketStatus(now, config.marketHolidays);
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
    dataSource: config.mockMode ? "mock" : "live",
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

/**
 * 组装 /fx 响应：汇率表。语义是「1 USD = rates[X] 个 X 币」。
 *
 * 收敛放在出参这一层而不是入库时：库里保留上游的完整精度，
 * 对外才给干净数字。这样就算哪天改了精度，不用重新抓一次上游。
 */
export function buildFxPayload(snapshot: SnapshotRecord, now: Date = new Date()): FxPayload {
  const rates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(snapshot.fx)) {
    rates[code] = roundTo(rate, FX_RATE_PRECISION);
  }
  return {
    serverTime: now.toISOString(),
    base: "USD",
    asOf: snapshot.fxAsOf,
    rates,
  };
}
