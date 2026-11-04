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

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface GenericConfig {
  /** 配置版本号。内容变了就 +1，客户端可以据此判断要不要更新本地缓存。 */
  configVersion: number;
  /** 任意 key → 任意值。 */
  values: Record<string, unknown>;
}

export class ConfigStore {
  private readonly path: string;
  private cached: GenericConfig | null = null;
  private cachedMtimeMs = 0;

  constructor(path: string) {
    this.path = resolve(path);
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
}
