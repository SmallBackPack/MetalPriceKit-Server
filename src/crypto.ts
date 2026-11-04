//
//  crypto.ts
//  MetalPriceKit Server
//  响应加密与密钥协商。客户端拿到的所有业务数据都是密文。
//
//  为什么用 X25519 + HKDF + AES-256-GCM 这一套：
//  - 服务端只有一把长期私钥，客户端持有对应公钥即可加解密，
//    不需要每个 App 安装都来注册一把自己的密钥（省掉一轮接口）。
//  - ECDH 出来的共享密钥每个客户端都不同，即使服务端只有一把私钥，
//    一个客户端的密钥泄露也不会波及其它客户端。
//  - 每次响应都换 nonce，且把 AAD 绑到「方法 + 路径 + kid」上，
//    密文被搬到别的接口上解不开。
//  - GCM 自带认证标签，篡改密文会解密失败，不会静默返回垃圾数据。
//
//  密钥轮换：MPK_SERVER_KEYS 可以同时配多把（k1、k2…），
//  客户端按信封里的 kid 选对应公钥解密，服务端换 activeKid 即可平滑轮换。
//
//  客户端实现要点（对应 Docs/客户端接入指南.md）：
//  - ECDH 用 X25519，与 Swift CryptoKit 的 Curve25519.KeyAgreement 对应。
//  - HKDF 的 salt 是固定常量「metalpricekit/v1」，info 区分方向：
//    请求方向 "…/request"，响应方向 "…/response"。
//    之所以 salt 用常量而不是拼公钥：共享密钥本身已经每个客户端唯一，
//    再拼公钥只会让客户端多拼一段字节，没有额外收益。
//

import { createCipheriv, createDecipheriv, diffieHellman, hkdfSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { createPrivateKey, createPublicKey } from "node:crypto";

/** 密钥对：raw 32 字节私钥 + raw 32 字节公钥。 */
export interface KeyPair {
  kid: string;
  privateKey: Buffer;
  publicKey: Buffer;
}

const HKDF_SALT = Buffer.from("metalpricekit/v1", "utf8");
const INFO_REQUEST = Buffer.from("metalpricekit/v1/request", "utf8");
const INFO_RESPONSE = Buffer.from("metalpricekit/v1/response", "utf8");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** X25519 PKCS#8 DER 前缀（16 字节），用于把 raw 私钥包装成 Node 可用的 KeyObject。 */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
/** X25519 SPKI DER 前缀（12 字节），用于把 raw 公钥包装成 KeyObject。 */
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function publicKeyToKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function privateKeyToKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/**
 * 客户端公钥与服务端私钥做 ECDH，派生会话密钥。
 *
 * 方向由 info 区分：请求方向与响应方向用不同密钥，
 * 防止把响应方向的密文拿来当请求方向用。
 */
export function deriveSessionKey(
  serverKey: KeyPair,
  clientPublic: Buffer,
  direction: "request" | "response",
): Buffer {
  const shared = diffieHellman({
    privateKey: privateKeyToKeyObject(serverKey.privateKey),
    publicKey: publicKeyToKeyObject(clientPublic),
  });
  const info = direction === "request" ? INFO_REQUEST : INFO_RESPONSE;
  return Buffer.from(hkdfSync("sha256", shared, HKDF_SALT, info, 32));
}

/** 从服务端私钥推出公钥（Node 没有直接的 raw→raw API，走 DER 包装）。 */
export function publicOf(serverPrivate: Buffer): Buffer {
  const der = createPublicKey(privateKeyToKeyObject(serverPrivate)).export({
    format: "der",
    type: "spki",
  });
  return der.subarray(der.length - 32);
}

/** 加密后的信封。客户端按这个结构解开。 */
export interface Envelope {
  /** 协议版本号，客户端据此判断格式。 */
  v: 1;
  /** 使用的密钥标识，对应服务端公钥表里的 kid。 */
  kid: string;
  /** 密文 base64，布局为 nonce(12) || ciphertext || tag(16)。 */
  c: string;
  /** 时间戳（毫秒）。给客户端做时钟校验与防重放。 */
  ts: number;
}

/**
 * 把明文加密成信封。
 *
 * @param plaintext 明文字符串
 * @param sessionKey 会话密钥
 * @param kid 密钥标识
 * @param aad 附加认证数据：绑定 method + path，防止密文跨接口搬运
 */
export function seal(
  plaintext: string,
  sessionKey: Buffer,
  kid: string,
  aad: string,
): Envelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sessionKey, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kid,
    // 布局固定为 nonce(12) || ciphertext || tag(16)，客户端按同样布局拆。
    c: Buffer.concat([nonce, ciphertext, tag]).toString("base64"),
    ts: Date.now(),
  };
}

/**
 * 解开信封。服务端自己也会用（解客户端的请求体、测试、运维排查）。
 */
export function open(envelope: Envelope, sessionKey: Buffer, aad: string): string {
  const raw = Buffer.from(envelope.c, "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("密文长度不合法");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", sessionKey, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * 构造 AAD。客户端必须用完全一样的字符串，否则解密失败。
 *
 * 约定： `${method}\n${path}\n${kid}`
 * 注意 path 是真实请求路径（不含查询串）。
 */
export function buildAad(method: string, path: string, kid: string): string {
  return `${method.toUpperCase()}\n${path}\n${kid}`;
}

/** 判断一个对象是不是合法的信封 —— 用来分辨请求体是明文 JSON 还是密文信封。 */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Envelope>;
  return v.v === 1 && typeof v.kid === "string" && typeof v.c === "string";
}
