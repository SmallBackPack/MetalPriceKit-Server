//
//  logger.ts
//  MetalPriceKit Server
//  最小可用的结构化日志。
//
//  为什么自己写而不用 pino：服务端只有一个进程、几个文件，
//  引入日志库要多一份依赖和一份配置。输出走 stdout 就行 ——
//  生产环境用 Docker 时由 docker logs 收走，不需要写文件。
//

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = (process.env.MPK_LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

export interface LogFn {
  (level: LogLevel, message: string, extra?: unknown): void;
}

export const log: LogFn = (level, message, extra) => {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (extra !== undefined) record.data = extra;
  // 单行 JSON，方便日志采集侧按行解析。
  const line = JSON.stringify(record, (_k, v) => (v instanceof Error ? v.message : v));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};
