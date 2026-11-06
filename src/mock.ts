//
//  mock.ts
//  MetalPriceKit Server
//  假数据源 —— 客户端联调用，不消耗任何上游额度。
//
//  数据是 config/mock-data.json 里的一份固定行情。
//  每次请求给价格加一点点递增的偏移（0.01），客户端一眼能看出「这次和上次不一样」。
//
//  它跟真实上游共用同一个接口（UpstreamSource），所以采集、涨跌计算、
//  加密、接口层全都是真跑 —— 联调通过的部分切回真实数据后不用重测。
//  唯一的区别是数据是假的。
//
//  ⚠️ 假数据必须能被一眼认出来，不能让人误当成真实行情发出去。
//     响应里有两处标记：响应头 X-MPK-Mock: 1，body 里 dataSource: "mock"。
//

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerConfig } from "./config.ts";
import type { UpstreamLatest, UpstreamSource } from "./upstream.ts";

interface MockData {
  /** 上游符号 → 基准价 */
  metals: Record<string, number>;
  /** 币种 → 「1 USD = ? 个该币种」 */
  currencies: Record<string, number>;
}

/**
 * 每次请求的相对偏移（0.01%）。
 *
 * 用相对值而不是绝对值：铜 13890 和黄金 4044 差三倍多，
 * 同样的绝对偏移对铜来说涨跌幅会小到看不见。
 */
const TICK_STEP = 0.0001;

export class MockUpstreamClient implements UpstreamSource {
  private readonly config: ServerConfig;
  private readonly data: MockData;
  /** 已经请求过几次。 */
  private tick = 0;

  constructor(options: { config: ServerConfig }) {
    this.config = options.config;
    const file = resolve(import.meta.dirname, "..", "config", "mock-data.json");
    this.data = JSON.parse(readFileSync(file, "utf8")) as MockData;
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
      const base = this.data.metals[metal.upstreamSymbol];
      if (base !== undefined) out[metal.code] = base;
    }
    return out;
  }

  async fetchLatest(): Promise<UpstreamLatest> {
    this.tick += 1;
    const factor = 1 + this.tick * TICK_STEP;

    const metals: Record<string, number> = {};
    for (const [symbol, base] of Object.entries(this.data.metals)) {
      metals[symbol] = base * factor;
    }

    // 上游给的是「1 X 币 = ? USD」，我们的契约是「1 USD = ? X 币」。
    // 文件里存的是后者，这里取倒数 —— 取倒数那条逻辑照样被跑到。
    const currencies: Record<string, number> = {};
    for (const [code, rate] of Object.entries(this.data.currencies)) {
      currencies[code] = code === "USD" ? 1 : 1 / rate;
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
