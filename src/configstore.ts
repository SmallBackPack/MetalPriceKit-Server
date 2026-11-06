//
//  configstore.ts
//  MetalPriceKit Server
//  通用配置下发。客户端拿到的就是一个 [key: Any] 字典。
//
//  为什么要有这个接口：
//  契约文档里的 /v1/config 是写死的结构（features / runtime / app / marketing），
//  适合「已知字段」的稳定契约。但产品运营经常要临时下发一些新东西
//  （开关、文案、阈值、公告），如果每加一个字段都要改服务端代码 + 发客户端版本，
//  流程太重。所以再开一个通用字典接口：结构完全由数据决定，客户端按需取。
//
//  数据来源是一个磁盘上的 JSON 文件，改完文件即生效（按 mtime 判断要不要重载），
// 不用重启服务、不用发版。
//
//  约定：
//  - 顶层必须是对象（字典），不能是数组或标量。
//  - 值可以是任意 JSON 值：字符串、数字、布尔、数组、嵌套对象、null。
//  - 客户端必须忽略不认识的 key（老版本遇到新字段不能崩）。
//
//  写入（后台配置控制台用）：
//  - 原子写：先写临时文件再 rename，避免热加载读到写了一半的文件。
//  - configVersion 由服务端接管，每次保存 +1 —— 客户端据此判断要不要刷新缓存。
//  - 保存前先备份，存 data/config-backups/，可以回滚。
//

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface GenericConfig {
  /** 配置版本号。内容变了就 +1，客户端可以据此判断要不要更新本地缓存。 */
  configVersion: number;
  /** 任意 key → 任意值。 */
  values: Record<string, unknown>;
}

/** 配置文件本身的信息。控制台编辑时看这个。 */
export interface ConfigFile {
  /** 文件里的原始内容，包含 configVersion 与下划线开头的元信息。 */
  raw: Record<string, unknown>;
  configVersion: number;
  /** 文件最后修改时间（ISO）。文件不存在时是 null。 */
  updatedAt: string | null;
  filePath: string;
}

export interface BackupInfo {
  /** 备份文件名（不含目录）。回滚时用它。 */
  file: string;
  configVersion: number;
  savedAt: string;
  sizeBytes: number;
}

export interface ValidationResult {
  ok: boolean;
  /** 不致命但值得提醒的问题，例如轮询间隔偏小。 */
  warnings: string[];
  /** 致命问题。ok=false 时 error 有值。 */
  error: string | null;
}

/**
 * pollIntervalSeconds 的下限护栏。
 *
 * 这个值是「客户端多久来问我们一次」。所有客户端加起来就是我们的 QPS：
 * 1000 个客户端按 15 秒轮询 = 约 67 QPS；改成 1 秒 = 1000 QPS。
 * 服务端的单 IP 限流是 60 次/分钟，客户端一旦密集轮询，
 * 同一 WiFi 下的用户会互相误伤（他们的请求来自同一个出口 IP）。
 * 所以低于下限直接拒绝保存 —— 这是护栏，不是建议。
 */
export const MIN_POLL_INTERVAL_SECONDS = 15;

/** 低于这个值会提示警告：服务端负载会明显上升。 */
export const POLL_INTERVAL_WARN_SECONDS = 30;

/** 顶层不允许出现的 key。防原型污染：JSON.parse 出来的 "__proto__" 是自有属性，
 *  合并进别处时可能污染原型。配置字典是我们自己的数据，不该出现这些。 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class ConfigStore {
  private readonly path: string;
  private readonly backupDir: string;
  private cached: GenericConfig | null = null;
  private cachedMtimeMs = 0;

  constructor(path: string, opts: { backupDir: string }) {
    this.path = resolve(path);
    this.backupDir = resolve(opts.backupDir);
  }

  /**
   * 读取当前配置。文件没变就直接返回缓存，避免每次请求都读盘。
   */
  load(): GenericConfig {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      // 文件不存在：返回空配置，不让整个服务起不来。
      // 配置是「锦上添花」，缺了不该导致行情接口不可用。
      return this.cached ?? { configVersion: 0, values: {} };
    }

    if (this.cached && mtimeMs === this.cachedMtimeMs) return this.cached;

    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        // 文件格式不对：沿用上一份可用配置，别让配置写错导致服务异常。
        return this.cached ?? { configVersion: 0, values: {} };
      }
      const values = raw as Record<string, unknown>;
      const version = typeof values.configVersion === "number" ? values.configVersion : 1;
      // configVersion 是元信息，不作为普通字段下发给客户端。
      const { configVersion: _ignored, ...rest } = values;
      // 下划线开头的 key 同样是元信息（_comment 之类），统一不下发 ——
      // 配置文件里的说明文字没有理由让客户端收到。
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (key.startsWith("_")) continue;
        payload[key] = value;
      }
      const next: GenericConfig = { configVersion: version, values: payload };
      this.cached = next;
      this.cachedMtimeMs = mtimeMs;
      return next;
    } catch {
      return this.cached ?? { configVersion: 0, values: {} };
    }
  }

  /** 当前配置版本号。 */
  get version(): number {
    return this.load().configVersion;
  }

  /** 读配置文件本身（含元信息）。控制台编辑与预览用。 */
  readFile(): ConfigFile {
    let raw: Record<string, unknown> = {};
    let updatedAt: string | null = null;
    try {
      const stat = statSync(this.path);
      updatedAt = new Date(stat.mtimeMs).toISOString();
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // 文件不存在或坏了：当成空字典。
      // 保存的时候再校验，坏文件不会因为「读不出来」就静默丢掉。
    }
    const version = typeof raw["configVersion"] === "number" ? raw["configVersion"] : 0;
    return { raw, configVersion: version, updatedAt, filePath: this.path };
  }

  /**
   * 保存配置。
   *
   * 流程：校验 → 备份旧文件 → 版本 +1 → 原子写 → 失效缓存。
   *
   * 版本号由服务端接管，不接受调用方指定 —— 让版本号只有一个来源，
   * 否则迟早出现「版本号比内容旧」的情况，客户端会拿着旧版本号跳过刷新。
   */
  save(raw: Record<string, unknown>): {
    configVersion: number;
    backup: BackupInfo | null;
    warnings: string[];
  } {
    const check = validateConfig(raw);
    if (!check.ok) {
      throw new ConfigError(check.error ?? "配置不合法");
    }

    const current = this.readFile();
    const backup = this.backupCurrent(current);

    const nextVersion = current.configVersion + 1;
    const next = orderKeys(raw, current.raw, nextVersion);

    this.writeAtomic(next);

    // 主动失效缓存：文件系统的 mtime 精度在不同平台上不一样（有的只有 1 秒），
    // 刚写完立刻读可能拿到旧缓存。宁可多读一次盘，也别让运营改完配置不生效。
    this.cached = null;
    this.cachedMtimeMs = 0;

    return { configVersion: nextVersion, backup, warnings: check.warnings };
  }

  /** 列出历史备份，新的在前。 */
  listBackups(): BackupInfo[] {
    let names: string[];
    try {
      names = readdirSync(this.backupDir);
    } catch {
      return [];
    }
    const infos: BackupInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const full = join(this.backupDir, name);
      try {
        const stat = statSync(full);
        const parsed = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
        const version = typeof parsed["configVersion"] === "number" ? parsed["configVersion"] : 0;
        infos.push({
          file: name,
          configVersion: version,
          savedAt: new Date(stat.mtimeMs).toISOString(),
          sizeBytes: stat.size,
        });
      } catch {
        // 读不出来的备份直接跳过，不让它把整个列表接口搞挂。
      }
    }
    infos.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return infos;
  }

  /**
   * 回滚到某个备份。
   *
   * 版本号不回退：内容回到旧样子，但 configVersion 继续 +1。
   * 理由是客户端只认「版本号变大」才刷新缓存。版本号一退，
   * 已经升级到新版本的客户端会认为「本地缓存是最新的」，于是永远拉不到回滚后的内容。
   */
  restore(backupFile: string): { configVersion: number; warnings: string[] } {
    const name = basename(backupFile);
    if (name !== backupFile || !name.endsWith(".json")) {
      throw new ConfigError("备份文件名不合法");
    }
    const full = join(this.backupDir, name);
    if (!existsSync(full)) {
      throw new ConfigError(`备份不存在：${name}`);
    }

    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(readFileSync(full, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("不是对象");
      }
      parsed = value as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`备份内容无法解析：${(err as Error).message}`);
    }

    const check = validateConfig(parsed);
    if (!check.ok) {
      throw new ConfigError(check.error ?? "备份内容不合法");
    }

    const current = this.readFile();
    const nextVersion = current.configVersion + 1;
    const next = orderKeys(parsed, current.raw, nextVersion);

    this.writeAtomic(next);
    this.cached = null;
    this.cachedMtimeMs = 0;

    return { configVersion: nextVersion, warnings: check.warnings };
  }

  /** 备份当前文件。文件不存在时返回 null —— 第一次保存没有「旧版本」可备。 */
  private backupCurrent(current: ConfigFile): BackupInfo | null {
    if (!existsSync(this.path)) return null;
    mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    const name = `remote-config-${stamp}-v${current.configVersion}.json`;
    const target = join(this.backupDir, name);
    copyFileSync(this.path, target);
    const stat = statSync(target);
    return {
      file: name,
      configVersion: current.configVersion,
      savedAt: new Date(stat.mtimeMs).toISOString(),
      sizeBytes: stat.size,
    };
  }

  /**
   * 原子写。
   *
   * 先写临时文件，再 rename 覆盖目标。rename 在同一文件系统内是原子的 ——
   * 读的人要么看到旧文件，要么看到新文件，不会看到写了一半的内容。
   * 这条对热加载特别重要：配置接口在每个请求上读文件，
   * 读到半个 JSON 会直接抛异常。
   */
  private writeAtomic(content: Record<string, unknown>): void {
    const dir = this.path.slice(0, this.path.lastIndexOf("/")) || ".";
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, formatConfigJson(content), "utf8");
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      // rename 失败时把临时文件清掉，别留垃圾。
      try {
        unlinkSync(tmp);
      } catch {
        /* 清不掉就算了，下次保存会覆盖它 */
      }
      throw new ConfigError(`写入配置文件失败：${(err as Error).message}`);
    }
  }
}

/**
 * 把配置序列化成 JSON 文本。
 *
 * 不用 JSON.stringify(value, null, 2)：那个会把手写的一行小数组拆成多行、
 * 把字段之间的空行全删掉。每次在控制台改一个字段，版本库里就出现一次全文件大改，
 * 根本看不出到底改了哪几行。
 *
 * 这里固定一套排版习惯（跟手写的配置文件保持一致）：
 *  - 顶层字段两格缩进
 *  - 同类型的标量挨在一起，不同类型或对象/数组之间空一行
 *  - 只含标量的数组短的话写在一行里
 *  - 对象永远展开成多行
 */
export function formatConfigJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  let text = "";

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const current = value[key];
    if (i > 0) {
      const previous = value[keys[i - 1]!];
      const separated =
        isBlockValue(current) ||
        isBlockValue(previous) ||
        typeTag(previous) !== typeTag(current);
      text += ",";
      if (separated) text += "\n";
      text += "\n";
    }
    text += `  ${JSON.stringify(key)}: ${formatConfigValue(current, 1)}`;
  }

  return `{\n${text}\n}\n`;
}

function formatConfigValue(value: unknown, indent: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const allScalar = value.every((v) => v === null || typeof v !== "object");
    if (allScalar) {
      const inline = `[${value.map((v) => JSON.stringify(v) ?? "null").join(", ")}]`;
      if (inline.length + pad.length <= 80) return inline;
      return `[\n${value.map((v) => inner + (JSON.stringify(v) ?? "null")).join(",\n")}\n${pad}]`;
    }
    return `[\n${value.map((v) => inner + formatConfigValue(v, indent + 1)).join(",\n")}\n${pad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const body = entries
    .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatConfigValue(v, indent + 1)}`)
    .join(",\n");
  return `{\n${body}\n${pad}}`;
}

/** 对象或数组 —— 这两种在文件里要展开成多行。 */
function isBlockValue(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function typeTag(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 输出顺序：configVersion 在最前，然后沿用原文件的字段顺序，新字段排最后。
 *
 * 为什么在意顺序：运营在控制台改完保存，版本库的 diff 应该只显示真正改动的几行。
 * 顺序一乱，每次保存都是全文件大改动，出问题时根本看不出改了哪儿。
 */
function orderKeys(
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
  version: number,
): Record<string, unknown> {
  const ordered: Record<string, unknown> = { configVersion: version };
  for (const key of Object.keys(previous)) {
    if (key === "configVersion") continue;
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      ordered[key] = next[key];
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = value;
    }
  }
  return ordered;
}

/** 配置相关的业务错误。带 400 语义。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 校验一份配置。
 *
 * 判定逻辑只此一处 —— 后台保存、回滚、脚本改文件都走它，
 * 免得「控制台不让改」但「手改文件能改出坏数据」。
 */
export function validateConfig(raw: unknown): ValidationResult {
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, warnings, error: "配置顶层必须是对象（键值对字典）" };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  for (const [key] of entries) {
    if (key.length === 0) {
      return { ok: false, warnings, error: "存在空字符串的 key" };
    }
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, warnings, error: `不允许的 key：${key}` };
    }
  }

  const poll = (raw as Record<string, unknown>)["pollIntervalSeconds"];
  if (poll !== undefined) {
    if (typeof poll !== "number" || !Number.isFinite(poll) || !Number.isInteger(poll)) {
      return { ok: false, warnings, error: "pollIntervalSeconds 必须是整数秒" };
    }
    if (poll < MIN_POLL_INTERVAL_SECONDS) {
      return {
        ok: false,
        warnings,
        error: `pollIntervalSeconds 不能小于 ${MIN_POLL_INTERVAL_SECONDS} 秒：所有客户端都按这个间隔来请求，间隔过小会打爆服务端并触发同出口 IP 的用户互相限流`,
      };
    }
    if (poll < POLL_INTERVAL_WARN_SECONDS) {
      warnings.push(
        `pollIntervalSeconds = ${poll} 偏小。${POLL_INTERVAL_WARN_SECONDS} 秒以上更稳，客户端越多差距越明显。`,
      );
    }
  }

  return { ok: true, warnings, error: null };
}
