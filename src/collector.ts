//
//  collector.ts
//  MetalPriceKit Server
//  行情采集器：定时问上游要数据，存快照，给 API 层读。
//
//  这个文件解决的是本项目最实际的约束 —— 上游免费额度只有 100 次/月。
//
//  额度怎么花（实测数据，2026-11）：
//  - /v1/latest      扣 1 次，一次拿回全部金属 + 全部汇率
//  - /v1/metal/spot  扣 1 次，只覆盖一个品种，且没有批量版
//  - /usage          不扣次数，可以随便查，用来对账
//
//  所以策略是：
//  - 只用 /v1/latest，不碰 spot（8 个品种就是 8 次请求，额度扛不住）
//  - 轮询间隔由配置决定，默认 10 分钟 —— 但那样一个月要 4320 次，远超额度
//  - 因此内置「额度刹车」：按当月剩余额度自动拉长间隔，绝不超支
//
//  刹车怎么算：
//  距月底还剩多少秒 ÷ 还剩多少次配额 = 每次调用至少要隔多久。
//  取这个值与配置间隔的较大者。这样月初额度富余时按配置频率跑，
//  月底额度紧张时自动放缓，最终不会把配额打穿。
//
//  上游挂掉时不报错：保留上一份快照继续对外服务，等下一轮重试。
//  契约里写明「上游行情源故障不是 5xx，走 200 + isStale」。
//

import type { ServerConfig } from "./config.ts";
import type { SnapshotRecord } from "./store.ts";
import { Store, tradeDateOf } from "./store.ts";
import { computeChange } from "./market.ts";
import { normalizeLatest, QuotaExceededError, type UpstreamSource } from "./upstream.ts";

export interface CollectorOptions {
  config: ServerConfig;
  store: Store;
  /** 数据源。真实上游与假数据实现共用这一个接口。 */
  upstream: UpstreamSource;
  log: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

export class Collector {
  private readonly config: ServerConfig;
  private readonly store: Store;
  private readonly upstream: UpstreamSource;
  private readonly log: CollectorOptions["log"];

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  /** 最近一次成功抓取的结果。内存里放一份，API 层直接读，不查库。 */
  private snapshot: SnapshotRecord | null = null;
  /** 最近一次抓取是否失败（用于 /health）。null = 本次进程还没抓过，正在用本地快照。 */
  private lastError: string | null = null;
  private lastFetchAt: string | null = null;
  private lastFetchOk: boolean | null = null;

  constructor(options: CollectorOptions) {
    this.config = options.config;
    this.store = options.store;
    this.upstream = options.upstream;
    this.log = options.log;

    // 启动时先把上次落库的快照读回来：进程重启后立刻能对外服务，
    // 不用等第一次采集（那要消耗一次额度）。
    const restored = this.store.loadSnapshot();
    if (restored) {
      this.snapshot = restored;
      this.lastFetchAt = restored.fetchedAt;
      this.log("info", "已从本地恢复上一份快照", { fetchedAt: restored.fetchedAt });
    }
  }

  get currentSnapshot(): SnapshotRecord | null {
    return this.snapshot;
  }

  get health(): {
    lastFetchAt: string | null;
    lastFetchOk: boolean | null;
    lastError: string | null;
    /** 有没有数据可以对外服务（本地快照也算）。 */
    hasSnapshot: boolean;
    upstreamUsed: number;
    upstreamBudget: number;
  } {
    return {
      lastFetchAt: this.lastFetchAt,
      lastFetchOk: this.lastFetchOk,
      lastError: this.lastError,
      hasSnapshot: this.snapshot !== null,
      upstreamUsed: this.upstream.used,
      upstreamBudget: this.config.monthlyRequestBudget,
    };
  }

  /**
   * 计算下一次采集的间隔。
   *
   * 额度刹车：当月剩余秒数 ÷ 剩余配额次数 = 每次调用最短间隔。
   * 与配置间隔取大者 —— 配置想更快，但额度不允许时，以额度为准。
   *
   * 假数据模式不刹车：压根没有额度要省，按配置间隔跑，
   * 客户端才能看到价格隔几秒就变一次。
   */
  nextIntervalMs(now = Date.now()): number {
    const configured = this.config.pollIntervalMs;
    if (this.config.mockMode) return configured;
    const month = monthKey(new Date(now));
    const used = Math.max(this.store.monthUsage(month), this.upstream.used);
    const remainingCalls = Math.max(0, this.config.monthlyRequestBudget - used);
    if (remainingCalls <= 0) {
      // 额度已用尽：退到 1 小时一轮，至少还能有机会在月初额度重置后恢复。
      return Math.max(configured, 60 * 60 * 1000);
    }
    const secondsLeftInMonth = secondsUntilNextMonth(now);
    const budgetFloorMs = (secondsLeftInMonth / remainingCalls) * 1000;
    return Math.max(configured, Math.ceil(budgetFloorMs));
  }

  /** 启动采集循环。fetchOnBoot 为真时先立刻抓一次（额外消耗一次额度）。 */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.config.fetchOnBoot) {
      await this.collectOnce();
    }
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = this.nextIntervalMs();
    this.timer = setTimeout(() => {
      void this.collectOnce().finally(() => this.scheduleNext());
    }, delay);
    // 不要因为这个定时器把进程钉住。
    this.timer.unref?.();
    this.log("info", "已安排下一轮采集", { delayMs: delay, delayMinutes: Math.round(delay / 60000) });
  }

  /**
   * 抓一轮。失败不抛 —— 采集失败不应该让整个服务挂掉。
   * 保留旧快照，交给 API 层按 isStale 标记对外。
   */
  async collectOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const latest = await this.upstream.fetchLatest();
      const normalized = normalizeLatest(latest, this.config);
      if (normalized.prices.size === 0) {
        throw new Error("上游返回的金属价格为空");
      }

      const fetchedAt = new Date().toISOString();
      const tradeDate = tradeDateOf(normalized.asOf);
      const codes = [...normalized.prices.keys()];

      // 假数据模式首次运行：播种「上一交易日收盘价」。
      // 不播种的话涨跌额永远是 0（没有基准可比），客户端测不了涨跌显示。
      if (this.config.mockMode && !this.store.hasAnyDailyClose()) {
        const baseline = this.upstream.baselinePrices;
        if (baseline && Object.keys(baseline).length > 0) {
          const seedDate = previousDate(tradeDate);
          this.store.seedDailyClose(seedDate, baseline);
          this.log("info", "假数据模式：已播种上一交易日的基准收盘价", { date: seedDate });
        }
      }

      // 先取上一交易日的收盘价与涨跌额，再算今天的涨跌。
      const prevCloses = this.store.prevCloseMap(codes, tradeDate);
      const prevChanges = this.store.prevChangeMap(codes, tradeDate);

      const snapshot: SnapshotRecord = {
        fetchedAt,
        metalAsOf: normalized.asOf,
        fxAsOf: normalized.fxAsOf,
        prices: Object.fromEntries(normalized.prices),
        fx: Object.fromEntries(normalized.currencyRates),
        hasPrevClose: prevCloses.size > 0,
      };

      // 把当天的收盘价与涨跌额落档。
      // 注意用「未四舍五入的原始价」算涨跌，和展示用的 scale 无关。
      for (const [code, price] of normalized.prices) {
        const prev = prevCloses.get(code) ?? null;
        const { change, changeRate } = computeChange(price, prev);
        this.store.recordDailyClose(tradeDate, code, price, change, changeRate);
      }

      this.store.saveSnapshot(snapshot);
      this.snapshot = snapshot;
      this.lastFetchAt = fetchedAt;
      this.lastFetchOk = true;
      this.lastError = null;
      this.log("info", "采集成功", {
        metals: normalized.prices.size,
        currencies: normalized.currencyRates.size,
        upstreamUsed: this.upstream.used,
      });
      return true;
    } catch (err) {
      this.lastFetchOk = false;
      this.lastError = (err as Error).message;
      if (err instanceof QuotaExceededError) {
        this.log("warn", "已达本月额度上限，跳过本轮采集", { error: this.lastError });
      } else {
        this.log("error", "采集失败，沿用上一份快照", { error: this.lastError });
      }
      return false;
    } finally {
      this.running = false;
    }
  }
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 前一个 UTC 日期（YYYY-MM-DD）。用来给假数据播种「上一交易日」的基准。 */
export function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** 距离下个月 1 号 00:00 UTC 还有多少秒。额度按自然月重置，所以对齐 UTC。 */
export function secondsUntilNextMonth(now: number): number {
  const d = new Date(now);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(0, (nextMonth - now) / 1000);
}
