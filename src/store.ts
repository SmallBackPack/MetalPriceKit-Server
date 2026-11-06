//
//  store.ts
//  MetalPriceKit Server
//  SQLite 持久化。用 Node 26 内置的 node:sqlite，不需要编译原生模块。
//
//  存三样东西，各有明确的必要性：
//  1. usage_counter —— 上游请求计数。必须落盘，否则进程重启后计数归零，
//     一次崩溃循环就能把当月 100 次额度烧光。
//  2. snapshot —— 最近一次成功的快照。作用有两个：重启后立刻能对外服务，
//     以及上游故障时拿旧数据兜底（契约要求故障降级返回旧快照 + stale 标记，
//     而不是报错让所有用户看到红页）。
//  3. daily_close —— 每个交易日的收盘价，用来算涨跌额。
//     上游 /v1/latest 只给价格不给涨跌，而逐个品种调 /v1/metal/spot 拿官方昨收
//     要 8 次请求；免费档一个月才 100 次，用不起。
//     所以我们自己按天留档，用「上一交易日我们观测到的收盘价」当涨跌基准。
//

import { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./config.ts";

export interface SnapshotRecord {
  fetchedAt: string;
  metalAsOf: string;
  fxAsOf: string;
  prices: Record<string, number>;
  fx: Record<string, number>;
  /** 是否已经拿到过上一交易日收盘价。没有的话涨跌额只能给 0。 */
  hasPrevClose: boolean;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS usage_counter (
        month    TEXT PRIMARY KEY,
        requests INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshot (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        fetched_at  TEXT    NOT NULL,
        metal_as_of TEXT    NOT NULL,
        fx_as_of    TEXT    NOT NULL,
        prices      TEXT    NOT NULL,
        fx          TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_close (
        trade_date  TEXT    NOT NULL,
        code        TEXT    NOT NULL,
        price       REAL    NOT NULL,
        change      REAL    NOT NULL DEFAULT 0,
        change_rate REAL    NOT NULL DEFAULT 0,
        PRIMARY KEY (trade_date, code)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── 上游请求计数 ────────────────────────────────────────────────

  /**
   * 记录一次上游请求，返回本月累计次数。
   * 计数按自然月分桶，与平台侧每月 1 号重置的节奏对齐。
   */
  recordUpstreamRequest(month: string): number {
    this.db
      .prepare(
        `INSERT INTO usage_counter (month, requests) VALUES (?, 1)
         ON CONFLICT(month) DO UPDATE SET requests = requests + 1`,
      )
      .run(month);
    return this.monthUsage(month);
  }

  monthUsage(month: string): number {
    const row = this.db
      .prepare(`SELECT requests FROM usage_counter WHERE month = ?`)
      .get(month) as { requests: number } | undefined;
    return row?.requests ?? 0;
  }

  /**
   * 用平台真实配额覆盖本地计数。
   *
   * 为什么要对账：本地计数只知道自己发了几次，但请求可能「发出去了但没收到响应」，
   * 这时平台已经扣了额度，本地不知道。额度是硬约束，宁可多算也不能少算。
   * 好在 /usage 不计入消耗，可以随便查。
   */
  syncUsage(month: string, platformUsed: number): void {
    const local = this.monthUsage(month);
    if (platformUsed > local) {
      this.db
        .prepare(
          `INSERT INTO usage_counter (month, requests) VALUES (?, ?)
           ON CONFLICT(month) DO UPDATE SET requests = excluded.requests`,
        )
        .run(month, platformUsed);
    }
  }

  // ── 快照 ────────────────────────────────────────────────────────

  saveSnapshot(snap: SnapshotRecord): void {
    this.db
      .prepare(
        `INSERT INTO snapshot (id, fetched_at, metal_as_of, fx_as_of, prices, fx)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fetched_at  = excluded.fetched_at,
           metal_as_of = excluded.metal_as_of,
           fx_as_of    = excluded.fx_as_of,
           prices      = excluded.prices,
           fx          = excluded.fx`,
      )
      .run(
        snap.fetchedAt,
        snap.metalAsOf,
        snap.fxAsOf,
        JSON.stringify(snap.prices),
        JSON.stringify(snap.fx),
      );
  }

  loadSnapshot(): SnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT fetched_at, metal_as_of, fx_as_of, prices, fx FROM snapshot WHERE id = 1`,
      )
      .get() as
      | { fetched_at: string; metal_as_of: string; fx_as_of: string; prices: string; fx: string }
      | undefined;
    if (!row) return null;
    const prices = JSON.parse(row.prices) as Record<string, number>;
    const fx = JSON.parse(row.fx) as Record<string, number>;
    return {
      fetchedAt: row.fetched_at,
      metalAsOf: row.metal_as_of,
      fxAsOf: row.fx_as_of,
      prices,
      fx,
      hasPrevClose: this.hasAnyDailyClose(),
    };
  }

  // ── 每日收盘价 ──────────────────────────────────────────────────

  /**
   * 记下某个交易日某个品种的观测价与当日涨跌。
   *
   * 同一天多次采集会覆盖成最新值 —— 这样一天结束时，留下的就是当天最后观测到的价格。
   * change / change_rate 一并存下来，是为了周末行情冻结时能沿用上一交易日的涨跌幅。
   */
  recordDailyClose(
    tradeDate: string,
    code: string,
    price: number,
    change: number,
    changeRate: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO daily_close (trade_date, code, price, change, change_rate)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trade_date, code) DO UPDATE SET
           price       = excluded.price,
           change      = excluded.change,
           change_rate = excluded.change_rate`,
      )
      .run(tradeDate, code, price, change, changeRate);
  }

  /**
   * 播种某一天的收盘价（涨跌记 0）。
   *
   * 只给假数据模式用：第一次跑没有任何历史，涨跌额会一直是 0，
   * 客户端测不了涨跌显示。播一份「上一交易日」的基准就有了。
   */
  seedDailyClose(tradeDate: string, prices: Record<string, number>): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO daily_close (trade_date, code, price, change, change_rate)
       VALUES (?, ?, ?, 0, 0)`,
    );
    for (const [code, price] of Object.entries(prices)) {
      stmt.run(tradeDate, code, price);
    }
  }

  /**
   * 取「早于指定交易日」的最近一次收盘观测值。
   *
   * 严格小于 today：今天的观测不能当自己的「上一交易日收盘」用。
   * 周末没有新价格，周日的观测值通常等于周五收盘，所以周末采到的数据
   * 也能正确充当下一个交易日的前收盘基准。
   */
  prevClose(code: string, beforeTradeDate: string): number | null {
    const row = this.db
      .prepare(
        `SELECT price FROM daily_close
         WHERE code = ? AND trade_date < ?
         ORDER BY trade_date DESC LIMIT 1`,
      )
      .get(code, beforeTradeDate) as { price: number } | undefined;
    return row?.price ?? null;
  }

  /**
   * 取上一交易日算出的涨跌额。
   * 行情冻结（周末/假期）时价格没动，靠这个值把涨跌幅延续下去。
   */
  prevChange(code: string, beforeTradeDate: string): { change: number; changeRate: number } | null {
    const row = this.db
      .prepare(
        `SELECT change, change_rate FROM daily_close
         WHERE code = ? AND trade_date < ?
         ORDER BY trade_date DESC LIMIT 1`,
      )
      .get(code, beforeTradeDate) as { change: number; change_rate: number } | undefined;
    if (!row) return null;
    return { change: row.change, changeRate: row.change_rate };
  }

  /** 是否已经积累过任何一天的收盘价。没有的话涨跌额只能给 0。 */
  hasAnyDailyClose(): boolean {
    const row = this.db.prepare(`SELECT 1 AS x FROM daily_close LIMIT 1`).get() as
      | { x: number }
      | undefined;
    return row !== undefined;
  }

  /** 上一次采集到的所有收盘价，作为「本交易日收盘」一并落档。 */
  prevCloseMap(codes: string[], beforeTradeDate: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const code of codes) {
      const v = this.prevClose(code, beforeTradeDate);
      if (v !== null) out.set(code, v);
    }
    return out;
  }

  /** 上一交易日的涨跌幅集合，用于冻结时沿用。 */
  prevChangeMap(
    codes: string[],
    beforeTradeDate: string,
  ): Map<string, { change: number; changeRate: number }> {
    const out = new Map<string, { change: number; changeRate: number }>();
    for (const code of codes) {
      const v = this.prevChange(code, beforeTradeDate);
      if (v !== null) out.set(code, v);
    }
    return out;
  }
}

/** 取 UTC 日期字符串，用作交易日分桶的 key。 */
export function tradeDateOf(iso: string): string {
  return iso.slice(0, 10);
}
