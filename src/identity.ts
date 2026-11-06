//
//  identity.ts
//  MetalPriceKit Server
//  设备标识的哈希。
//
//  为什么哈希：库里不应该留原始设备标识。
//  deviceId 来自客户端 Keychain 里的 UUID，vendorId 来自 IDFV ——
//  两者都算「设备标识」，属于个人信息的边缘地带。
//  存哈希之后，库里只有不可逆的摘要，统计口径完全不受影响，
//  但库被拖走时拿不到可直接关联到设备的原始值。
//
//  pepper 从哪来：
//  - 优先读环境变量 MPK_ID_PEPPER。生产环境多实例部署时，所有实例必须用同一个值，
//    否则同一个设备在两台机器上会被算成两个用户。
//  - 没有就生成一个随机 pepper 存到 data/id-pepper 文件。
//  pepper 丢了，所有哈希都对不上，用户会被当成全新装机重新计数 ——
//  所以这个文件必须跟数据库一起备份。
//

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 哈希值前缀。
 *
 * 作用有两个：
 * 1. 一眼能看出这列里是哈希值还是明文 —— 早期版本直接存的是明文 deviceId。
 * 2. 以后换哈希算法（比如加盐方式变了）可以并存两套，不会撞。
 */
export const HASH_PREFIX = "h1:";

/** 用服务端 pepper 对设备标识做 HMAC。pepper 是密钥，标识本身不是密钥。 */
export function hashIdentifier(pepper: string, raw: string): string {
  return HASH_PREFIX + createHmac("sha256", pepper).update(raw, "utf8").digest("hex");
}

/**
 * 读取 pepper。
 *
 * env 优先；没有 env 就用文件；文件也没有就生成一个新的并写盘。
 */
export function loadPepper(envValue: string, pepperFile: string): string {
  if (envValue) return envValue;

  const path = resolve(pepperFile);
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }

  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  // 0600：这个文件等价于「设备标识的解密密钥」，别让同机器的其他用户读到。
  writeFileSync(path, generated, { encoding: "utf8", mode: 0o600 });
  return generated;
}
