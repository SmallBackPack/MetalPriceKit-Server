//
//  upstream.ts
//  MetalPriceKit Server
//  metals.dev 上游适配层。唯一发起上游请求的地方。
//
//  额度是本项目最硬的约束：免费档 100 次/月，且超额后不额外收费但会断供。
//  所以这里做了三件事：
//  1. 记账：每次真实请求都写进 usage 表，日志与 /health 都能看到余量。
//  2. 刹车：达到当月预算上限就拒绝再发请求，转而用本地快照兜底。
//  3. 复用：/v1/latest 一次拿回全部金属 + 全部汇率，
//     单金属 /v1/metal/spot 只有在需要「官方昨收涨跌」时才按品种逐个请求。
//
//  上游符号映射在 config/metals.json，切换供应商只改那张表。
//

import type { ServerConfig } from "./config.ts";

export interface UpstreamLatest {
  status: string;
  currency: string;
  unit: string;
  metals: Record<string, number>;
  currencies: Record<string, number>;
  timestamps: { metal: string; currency: string };
}

export interface UpstreamSpot {
  status: string;
  timestamp: string;
  currency: string;
  unit: string;
  metal: string;
  rate: {
    price: number;
    ask: number;
    bid: number;
    high: number;
    low: number;
    change: number;
    change_percent: number;
  };
}

export interface UsageInfo {
  plan: string;
  total: number;
  used: number;
  remaining: number;
}

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export interface UpstreamClientOptions {
  config: ServerConfig;
  /** 记账回调：每次请求后拿到本次消耗与余量。 */
  onUsage?: (used: number, remaining: number) => void;
}

/**
 * 上游数据源。
 *
 * 真实实现（UpstreamClient）与假数据实现（MockUpstreamClient）共用这一个接口，
 * 采集器不关心数据从哪来 —— 切模式只换一行构造代码。
 */
export interface UpstreamSource {
  fetchLatest(): Promise<UpstreamLatest>;
  /** 本月已消耗的请求数。mock 恒为 0。 */
  readonly used: number;
  /** 本月剩余可用次数。 */
  readonly remaining: number;
  /**
   * 基准价（我们的品种 code → 价格）。
   *
   * mock 模式用它播种「上一交易日收盘价」—— 不播种的话涨跌额永远是 0，
   * 客户端测不了涨跌显示。真实上游返回 null。
   */
  readonly baselinePrices: Record<string, number> | null;
}

export class UpstreamClient implements UpstreamSource {
  private readonly config: ServerConfig;
  private readonly onUsage?: (used: number, remaining: number) => void;
  /** 本进程内已消耗的请求数（跨月自动清零）。 */
  private usedThisMonth = 0;
  private currentMonth = monthKey();

  constructor(options: UpstreamClientOptions) {
    this.config = options.config;
    this.onUsage = options.onUsage;
  }

  /** 本月已用次数（进程内计数）。 */
  get used(): number {
    this.rollMonthIfNeeded();
    return this.usedThisMonth;
  }

  /** 本月剩余可用次数（按预算上限算，不含平台自身余量）。 */
  get remaining(): number {
    return Math.max(0, this.config.monthlyRequestBudget - this.used);
  }

  /** 真实上游没有「基准价」的概念 —— 涨跌基准靠服务端自己的每日留档。 */
  get baselinePrices(): Record<string, number> | null {
    return null;
  }

  private rollMonthIfNeeded(): void {
    const now = monthKey();
    if (now !== this.currentMonth) {
      this.currentMonth = now;
      this.usedThisMonth = 0;
    }
  }

  /**
   * 消费一次额度。超预算直接抛错，让调用方走降级路径。
   * 这一层是「绝不烧超额度」的唯一保证。
   */
  private consumeQuota(): void {
    this.rollMonthIfNeeded();
    if (this.usedThisMonth >= this.config.monthlyRequestBudget) {
      throw new QuotaExceededError(
        `本月上游请求额度已用尽（${this.config.monthlyRequestBudget}），停止访问上游`,
      );
    }
    this.usedThisMonth += 1;
  }

  private async request<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (!this.config.upstreamApiKey) {
      throw new UpstreamError("未配置 METALS_DEV_API_KEY", 500);
    }
    this.consumeQuota();
    const url = new URL(path, this.config.upstreamBaseUrl);
    url.searchParams.set("api_key", this.config.upstreamApiKey);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (err) {
      // 网络层失败同样算一次尝试 —— 额度已经扣了，不能假装没花。
      throw new UpstreamError(`上游请求失败：${(err as Error).message}`, 502);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamError(`上游返回 ${res.status}：${text.slice(0, 200)}`, res.status);
    }
    this.onUsage?.(this.usedThisMonth, this.remaining);
    return JSON.parse(text) as T;
  }

  /**
   * 一次拿回全部金属价格 + 全部汇率。
   *
   * 实测（2026-11）：不传 unit 时上游就是「贵金属 toz + 工业金属公吨」的混合口径，
   * 正好等于我们契约里的 baseUnit，服务端零换算。所以这里不传 unit。
   */
  async fetchLatest(): Promise<UpstreamLatest> {
    return this.request<UpstreamLatest>("/v1/latest", { currency: "USD" });
  }

  /**
   * 单品种现货，含官方「对比前一交易日」的涨跌。
   *
   * 上游没有批量版（实测 /v1/metal/spot 必须带 metal 参数），
   * 所以 8 个品种就是 8 次请求，预算紧张时要省着用。
   */
  async fetchSpot(metal: string): Promise<UpstreamSpot> {
    return this.request<UpstreamSpot>("/v1/metal/spot", { metal, currency: "USD" });
  }

  /**
   * 查询平台侧的真实配额。
   *
   * 实测（2026-11）：/usage 这个路径不计入消耗，可以随便查，用来对账。
   */
  async fetchUsage(): Promise<UsageInfo> {
    if (!this.config.upstreamApiKey) throw new UpstreamError("未配置 METALS_DEV_API_KEY", 500);
    const url = new URL("/usage", this.config.upstreamBaseUrl);
    url.searchParams.set("api_key", this.config.upstreamApiKey);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new UpstreamError(`查询配额失败：${res.status}`, res.status);
    const j = (await res.json()) as {
      status: string;
      plan: string;
      total: number;
      used: number;
      remaining: number;
    };
    return { plan: j.plan, total: j.total, used: j.used, remaining: j.remaining };
  }
}

function monthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 把上游 latest 响应归一化成本项目的品种字典结构。
 *
 * 上游给的是「上游符号 → 价格」，这里转成「我们的 code → 价格」，
 * 符号映射来自 config/metals.json，不硬编码在业务逻辑里。
 */
export function normalizeLatest(
  latest: UpstreamLatest,
  config: ServerConfig,
): { prices: Map<string, number>; currencyRates: Map<string, number>; asOf: string; fxAsOf: string } {
  const prices = new Map<string, number>();
  for (const metal of config.metals) {
    const raw = latest.metals[metal.upstreamSymbol];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    prices.set(metal.code, raw);
  }

  // 上游给的是「1 单位 X 币 = ? USD」，我们的契约是「1 USD = rates[X] 个 X 币」，方向相反，取倒数。
  const currencyRates = new Map<string, number>();
  for (const code of config.currencyAllowlist) {
    const usdPerUnit = latest.currencies[code];
    if (typeof usdPerUnit !== "number" || !Number.isFinite(usdPerUnit) || usdPerUnit <= 0) continue;
    currencyRates.set(code, 1 / usdPerUnit);
  }
  currencyRates.set("USD", 1);

  return {
    prices,
    currencyRates,
    asOf: latest.timestamps?.metal ?? new Date().toISOString(),
    fxAsOf: latest.timestamps?.currency ?? new Date().toISOString(),
  };
}
