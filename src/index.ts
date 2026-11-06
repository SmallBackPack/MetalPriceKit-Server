//
//  index.ts
//  MetalPriceKit Server
//  进程入口：装配依赖、启动 HTTP 服务、启动采集器。
//
//  启动顺序有讲究：
//  1. 先把本地快照读回来（采集器构造时就会做），
//     这样即使上游此刻不可用，服务起来也能立刻返回上一份数据，
//     而不是 503 让所有客户端看到错误页。
//  2. 再启动 HTTP 监听。
//  3. 最后启动采集循环。
//

import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { Collector } from "./collector.ts";
import { MockUpstreamClient } from "./mock.ts";
import { Store } from "./store.ts";
import { UserStore } from "./userstore.ts";
import { ConfigStore } from "./configstore.ts";
import { UpstreamClient } from "./upstream.ts";
import { log } from "./logger.ts";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";

async function main(): Promise<void> {
  const config = loadConfig();

  mkdirSync(config.dataDir, { recursive: true });

  // 市场数据与用户数据分开两个 SQLite 文件：
  // 市场数据是「只有一份、全站共享」的热数据，用户数据是低频写入。
  // 分开的好处是备份与清理策略可以各自独立，也不会因为用户表锁竞争卡住行情读取。
  const marketDb = new DatabaseSync(resolve(config.dataDir, "market.db"));
  const userDb = new DatabaseSync(resolve(config.dataDir, "user.db"));

  const store = new Store(marketDb);
  const users = new UserStore(userDb);

  // 数据源：真实上游，或假数据。
  // 两者共用同一个接口，采集器与之后的每一层都不知道数据从哪来。
  const upstream = config.mockMode
    ? new MockUpstreamClient({ config })
    : new UpstreamClient({ config });

  if (config.mockMode) {
    log("warn", "假数据模式已开启：不请求上游、不消耗额度，返回的是模拟行情", {
      pollIntervalMs: config.pollIntervalMs,
    });
  } else if (!config.upstreamApiKey) {
    log("warn", "未配置 METALS_DEV_API_KEY：上游不可用，服务将以本地快照对外服务");
  }

  const collector = new Collector({ config, store, upstream, log });

  const genericConfig = new ConfigStore(config.remoteConfigFile);
  if (!existsSync(config.remoteConfigFile)) {
    // 配置是锦上添花，缺了不至于让服务起不来 —— 但必须喊一声，
    // 否则通用字段接口会一直返回空字典而没人知道。
    log("warn", "通用配置文件不存在，通用字段接口将返回空字典", {
      file: config.remoteConfigFile,
    });
  }

  const app = createApp({ config, collector, store, users, genericConfig });

  const server = app.listen(config.port, config.host, () => {
    log("info", "HTTP 服务已启动", {
      host: config.host,
      port: config.port,
      pollIntervalMs: config.pollIntervalMs,
      monthlyBudget: config.monthlyRequestBudget,
    });
  });

  server.on("error", (err) => {
    log("error", "HTTP 服务出错", { error: err.message });
    process.exit(1);
  });

  // 启动采集循环（不阻塞进程启动）。
  void collector.start();

  const shutdown = (signal: string) => {
    log("info", "收到退出信号，开始收尾", { signal });
    collector.stop();
    server.close(() => {
      store.close();
      userDb.close();
      marketDb.close();
      process.exit(0);
    });
    // 兜底：5 秒还没关干净就强制退出，避免容器停不下来。
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log("error", "启动失败", { error: (err as Error).message });
  process.exit(1);
});
