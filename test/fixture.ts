//
//  fixture.ts
//  MetalPriceKit Server
//  本地假上游。测试专用。
//
//  为什么要造假上游：
//  上游免费额度只有 100 次/月，真实调用一次就少一次。
//  测试如果打真实上游，跑几轮就把额度烧光了 —— 那是真金白银的额度。
//  所以起一个本地 HTTP 服务，返回形状与上游一致的 JSON，
//  顺便把真实响应存成样本文件，保证测试覆盖的是真实的字段结构。
//

import { createServer } from "node:http";
import type { Server } from "node:http";

/** 真实上游响应样本（2026-11-04 采集，已去掉 api_key）。字段结构与线上一致。 */
export const LATEST_SAMPLE = {
  status: "success",
  currency: "USD",
  unit: "default",
  metals: {
    gold: 4061.325,
    silver: 52.199,
    platinum: 1497.9,
    palladium: 1004.279,
    lbma_gold_am: 4043.65,
    lbma_gold_pm: 4037.8,
    lbma_silver: 51.99,
    lbma_platinum_am: 1462.3,
    lbma_platinum_pm: 1468.7,
    lbma_palladium_am: 987.85,
    lbma_palladium_pm: 988.25,
    mcx_gold: 4713.3242,
    ibja_gold: 4660.2189,
    copper: 14306.8661,
    aluminum: 3053.8,
    lead: 1871.8,
    nickel: 15852.5,
    zinc: 3776.44,
    lme_copper: 14001,
    lme_aluminum: 3042,
    lme_lead: 1894,
    lme_nickel: 15375,
    lme_zinc: 3810,
  },
  currencies: {
    AED: 0.2722940776,
    AUD: 0.700658633,
    BTC: 80244.5854965936,
    BYR: 0.000036561,
    CNH: 0.1498184131,
    CNY: 0.1498035959,
    EEK: 0.0716833304,
    EUR: 1.1216032649,
    GBP: 1.3461762437,
    HKD: 0.1274611438,
    JPY: 0.0063341859,
    KRW: 0.0007481934,
    TWD: 0.0308483352,
    USD: 1,
    XDR: 1.3575601122,
    ZWD: 0.00276319,
  },
  timestamps: {
    metal: "2026-11-04T18:56:11.083Z",
    currency: "2026-11-04T18:58:11.590Z",
  },
};

export interface FakeUpstream {
  server: Server;
  baseUrl: string;
  /** 记录收到的请求路径，用于断言调用次数。 */
  calls: string[];
  /** 让下一次请求失败，用来测试降级路径。 */
  failNext: boolean;
  close: () => Promise<void>;
}

/** 起一个本地假上游。 */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const calls: string[] = [];
  const state = { failNext: false };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push(url.pathname);

    if (state.failNext) {
      state.failNext = false;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "failure", error_code: 500 }));
      return;
    }

    if (url.pathname === "/v1/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(LATEST_SAMPLE));
      return;
    }

    if (url.pathname === "/v1/metal/spot") {
      const metal = url.searchParams.get("metal") ?? "gold";
      const price = (LATEST_SAMPLE.metals as Record<string, number>)[metal] ?? 1000;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "success",
          timestamp: "2026-11-04T19:02:13.039Z",
          currency: "USD",
          unit: metal === "gold" ? "toz" : "mt",
          metal,
          rate: {
            price,
            ask: price + 0.3,
            bid: price - 0.3,
            high: price + 9,
            low: price - 141,
            change: 131.34,
            change_percent: 3.34,
          },
        }),
      );
      return;
    }

    if (url.pathname === "/usage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ status: "success", plan: "Free", total: 100, used: 0, remaining: 100 }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "failure", error_code: 404 }));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    get failNext() {
      return state.failNext;
    },
    set failNext(v: boolean) {
      state.failNext = v;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}
