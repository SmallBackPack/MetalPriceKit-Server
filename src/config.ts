//
//  config.ts
//  MetalPriceKit Server
//  集中读取环境变量与配置文件，是「配置只有一个来源」的唯一落点。
//
//  为什么单独一个文件：采集频率、端口、上游 key 这类东西会被运维改，
//  散落在各个模块里读 process.env 就没法一眼看全当前生效值。
//

import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MetalDef {
  code: string;
  name: string;
  baseUnit: "oz" | "t";
  scale: number;
  category: "precious" | "industrial";
  order: number;
  /** 上游 metals.dev 的符号。切换供应商时改这一列即可，业务逻辑不动。 */
  upstreamSymbol: string;
}

/**
 * 对外路径表。
 *
 * 写成具体字段而不是索引签名，是为了拿到编译期检查 ——
 * 少配一个路径会在启动时直接报错，而不是等到请求 404 才发现。
 */
export interface RouteMap {
  /** 密钥协商。必须明文，客户端此时还没有密钥。 */
  bootstrap: string;
  quotes: string;
  metals: string;
  fx: string;
  /** 契约里的结构化配置。 */
  config: string;
  /** 通用字段字典。 */
  fields: string;
  auth: string;
  profile: string;
  feedback: string;
  crash: string;
  events: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** metals.dev 的 API key。绝不入库、绝不进版本库，只走环境变量。 */
  upstreamApiKey: string;
  upstreamBaseUrl: string;
  /** 上游轮询间隔（毫秒）。默认值要配合月度额度算，见 Docs/服务端部署与额度.md。 */
  pollIntervalMs: number;
  /** 每月上游请求上限。硬上限，防止脚本跑飞把额度烧光。 */
  monthlyRequestBudget: number;
  /** 客户端加密用的服务端密钥对（base64 的 X25519 原始字节）。 */
  serverKeys: { kid: string; privateKey: Buffer; publicKey: Buffer }[];
  /** 当前用于加密响应的 kid。 */
  activeKid: string;
  metals: MetalDef[];
  routes: RouteMap;
  /** 货币白名单：上游给 174 个，含已废弃币种与加密货币，必须过滤。 */
  currencyAllowlist: string[];
  /** 金属市场休市日（伦敦本地日期，YYYY-MM-DD）。 */
  marketHolidays: string[];
  /** 启动时是否立刻拉一次上游（不拉则等首个轮询周期）。 */
  fetchOnBoot: boolean;
  /**
   * 假数据模式。不请求上游，数据是模拟的，**不消耗额度**。
   *
   * 客户端联调用这个 —— 真实上游一个月只有 100 次额度，
   * 联调阶段打真实上游几天就能烧光，而额度要等下个月才重置。
   */
  mockMode: boolean;
  dataDir: string;
  /** 通用字段字典的文件路径。改文件即生效，不用重启。 */
  remoteConfigFile: string;
}

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
const ROOT = resolve(import.meta.dirname, "..");

/**
 * 服务端密钥对。
 *
 * 用法：
 *   MPK_SERVER_KEYS  = "k1:<base64私钥>,k2:<base64私钥>"
 *   MPK_ACTIVE_KID   = "k1"
 * 留空则自动生成一把随机密钥（仅本次进程有效，重启后客户端解不开）。
 */
function loadServerKeys(): { keys: ServerConfig["serverKeys"]; activeKid: string } {
  const raw = envStr("MPK_SERVER_KEYS", "");
  const activeKid = envStr("MPK_ACTIVE_KID", "k1");
  if (!raw) {
    throw new Error(
      "缺少 MPK_SERVER_KEYS。生成方式：node -e \"console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const keys = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx <= 0) throw new Error(`MPK_SERVER_KEYS 格式错误：${entry}`);
      const kid = entry.slice(0, idx);
      const priv = Buffer.from(entry.slice(idx + 1), "base64");
      if (priv.length !== 32) throw new Error(`密钥 ${kid} 长度应为 32 字节，实际 ${priv.length}`);
      return { kid, privateKey: priv, publicKey: derivePublicKey(priv) };
    });
  if (keys.length === 0) throw new Error("MPK_SERVER_KEYS 为空");
  if (!keys.some((k) => k.kid === activeKid)) {
    throw new Error(`MPK_ACTIVE_KID=${activeKid} 不在 MPK_SERVER_KEYS 中`);
  }
  return { keys, activeKid };
}

/**
 * 由 X25519 私钥算出公钥。
 *
 * Node 没有直接暴露「raw 私钥 → raw 公钥」的 API，
 * 这里走一遍 PKCS#8/SPKI 的 DER 封装再取末尾 32 字节。
 */
export function derivePublicKey(privateKey: Buffer): Buffer {
  // X25519 PKCS#8 前缀（固定 16 字节）+ 32 字节私钥 = 48 字节 DER
  const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const der = Buffer.concat([pkcs8Prefix, privateKey]);
  const pubDer = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({
    format: "der",
    type: "spki",
  });
  // SPKI DER 末尾 32 字节即 raw 公钥
  return pubDer.subarray(pubDer.length - 32);
}

export function loadConfig(): ServerConfig {
  const metalsFile = readJsonFile<{ metals: MetalDef[] }>(resolve(ROOT, "config/metals.json"));
  const routesFile = readJsonFile<{ routes: RouteMap }>(resolve(ROOT, "config/routes.json"));
  const currenciesFile = readJsonFile<{ allowlist: string[] }>(resolve(ROOT, "config/currencies.json"));
  const holidaysFile = readJsonFile<{ holidays: string[] }>(resolve(ROOT, "config/holidays.json"));
  const { keys, activeKid } = loadServerKeys();
  const mockMode = envBool("MPK_MOCK", false);

  // 假数据模式用独立的数据目录。
  // 原因：采集器会把「当日收盘价」写进 daily_close，而涨跌基准正是从那里取的。
  // 假数据写进去会覆盖真实行情的历史，切回真实数据后涨跌就算错了。
  // 分开存，真实历史一点不脏。
  const dataDir = envStr("MPK_DATA_DIR", mockMode ? "data-mock" : "data");

  return {
    port: envInt("PORT", 8787),
    host: envStr("HOST", "0.0.0.0"),
    upstreamApiKey: envStr("METALS_DEV_API_KEY", ""),
    upstreamBaseUrl: envStr("METALS_DEV_BASE_URL", "https://api.metals.dev"),
    pollIntervalMs: envInt("MPK_POLL_INTERVAL_MS", 10 * 60 * 1000),
    monthlyRequestBudget: envInt("MPK_MONTHLY_BUDGET", 100),
    serverKeys: keys,
    activeKid,
    metals: metalsFile.metals,
    routes: routesFile.routes,
    currencyAllowlist: currenciesFile.allowlist,
    marketHolidays: holidaysFile.holidays,
    // 假数据模式默认启动即拉一次 —— 不花额度，没理由让人等。
    // 真实上游默认不拉：每次启动都烧一次额度太浪费（一个月才 100 次）。
    fetchOnBoot: envBool("MPK_FETCH_ON_BOOT", mockMode),
    mockMode,
    dataDir: resolve(ROOT, dataDir),
    remoteConfigFile: resolve(ROOT, envStr("MPK_REMOTE_CONFIG_FILE", "config/remote-config.json")),
  };
}

export { ROOT };
