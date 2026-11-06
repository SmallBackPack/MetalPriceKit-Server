//
//  mock.ts
//  MetalPriceKit Server
//  假数据源 —— 客户端联调时用，不消耗任何上游额度。
//
//  为什么需要它：
//  上游免费档一个月只有 100 次请求，客户端联调要是打真实上游，
//  几天就能把额度烧光，而额度要等下个月才重置。
//  联调阶段要的是「稳定、随叫随到、可以反复重置」的数据，不是真实行情。
//
//  它跟真实上游共用同一个接口（UpstreamSource），所以采集器、
//  涨跌计算、加密、接口层全都是真跑 —— 联调通过的部分在切回真实数据后不用重测。
//  唯一的区别是数据是假的。
//
//  ⚠️ 假数据必须能被一眼认出来，不能让人误当成真实行情发出去。
//     响应里有两处标记：响应头 X-MPK-Mock: 1，body 里 dataSource: "mock"。
//
//  数据形状与真实上游完全一致（同样的符号、同样的字段、同样的方向），
//  所以归一化、汇率取倒数、货币白名单这些逻辑都会被真实跑到。
//

import type { ServerConfig } from "./config.ts";
import type { UpstreamLatest, UpstreamSource } from "./upstream.ts";

/**
 * 基准价。取自 2026-11 的真实行情 —— 量级要像，
 * 否则客户端的格式化、小数位、单位换算这些逻辑测不出来。
 */
const BASE_METALS: Record<string, number> = {
  gold: 4044.3,
  silver: 51.474,
  platinum: 1513.4,
  palladium: 1019.756,
  copper: 13890.68,
  nickel: 16259.5,
  aluminum: 3045.3,
  zinc: 3750.9,
};

/**
 * 汇率基准。语义是「1 USD = ? X 币」（与我们的契约一致）。
 * 往上游格式转换时会取倒数 —— 这样「汇率取倒数」这条逻辑也照样被跑到。
 */
const BASE_FX: Record<string, number> = {
  USD: 1,
  CNY: 6.67049061,
  CNH: 6.66697705,
  EUR: 0.89303673,
  JPY: 157.9253461,
  HKD: 7.83546704,
  GBP: 0.74438869,
  KRW: 1356.82485616,
  TWD: 32.95298873,
  AUD: 1.44902323,
  CAD: 1.4039318,
  CHF: 0.81708507,
  SGD: 1.28016521,
  NZD: 1.79616466,
  SEK: 9.83357514,
  NOK: 9.31914331,
  DKK: 6.67496333,
  PLN: 3.93266556,
  INR: 94.38742453,
  RUB: 81.49199999,
  BRL: 5.50413987,
  MXN: 18.75434932,
  ZAR: 16.52468842,
  TRY: 50.16107272,
  IDR: 18129.07904278,
  THB: 33.4917188,
};

/** 每轮价格漂移的上限（±0.15%）。要够小才像行情，要够大才看得出「价格在动」。 */
const STEP = 0.0015;
/** 累计偏离基准的上限（±5%）。防止跑久了飘到不合理的价位。 */
const MAX_DRIFT = 0.05;

export class MockUpstreamClient implements UpstreamSource {
  private readonly config: ServerConfig;
  /** 每个品种相对基准的累计偏移。放在内存里 —— 重启就重新开始。 */
  private readonly drift = new Map<string, number>();
  /** 已经产生了几轮。给日志和排查用。 */
  private tick = 0;

  constructor(options: { config: ServerConfig }) {
    this.config = options.config;
  }

  /** mock 模式不消耗任何额度。 */
  get used(): number {
    return 0;
  }

  get remaining(): number {
    return this.config.monthlyRequestBudget;
  }

  /**
   * 基准价（我们的品种 code → 价格）。
   * 采集器用它播种「上一交易日收盘价」，让涨跌额一开始就不是 0。
   */
  get baselinePrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const metal of this.config.metals) {
      const base = BASE_METALS[metal.upstreamSymbol];
      if (base !== undefined) out[metal.code] = base;
    }
    return out;
  }

  async fetchLatest(): Promise<UpstreamLatest> {
    this.tick += 1;

    const metals: Record<string, number> = {};
    for (const [symbol, base] of Object.entries(BASE_METALS)) {
      const prev = this.drift.get(symbol) ?? 0;
      const next = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, prev + (Math.random() - 0.5) * 2 * STEP));
      this.drift.set(symbol, next);
      metals[symbol] = base * (1 + next);
    }

    // 上游给的是「1 X 币 = ? USD」，所以这里要取倒数 ——
    // 与真实上游的方向保持一致，归一化那一步的逻辑才会被真实跑到。
    const currencies: Record<string, number> = {};
    for (const [code, rate] of Object.entries(BASE_FX)) {
      if (code === "USD") {
        currencies[code] = 1;
        continue;
      }
      const jitter = 1 + (Math.random() - 0.5) * 0.0005;
      currencies[code] = 1 / (rate * jitter);
    }

    const now = new Date().toISOString();
    return {
      status: "success",
      currency: "USD",
      unit: "default",
      metals,
      currencies,
      timestamps: { metal: now, currency: now },
    };
  }
}
