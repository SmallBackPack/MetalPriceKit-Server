//
//  scripts/smoke.ts
//  MetalPriceKit Server
//  客户端侧参考实现 + 部署自检。
//
//  它做的正是 Swift 客户端将来要做的那几件事：
//  1. 调 bootstrap 拿服务端公钥
//  2. 自己生成一把 X25519 密钥对
//  3. ECDH + HKDF 派生会话密钥（响应方向）
//  4. 请求业务接口，把返回的密文解开
//
//  两个用途：
//  - 给 Swift 端一个可对照的参考实现（CryptoKit 的每一步都对应得上）
//  - 部署之后验证「线上这一套加解密链路是通的」
//
//  用法：node scripts/smoke.ts [baseUrl]
//  不传 baseUrl 时默认打本地 8787 端口。
//

import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

const BASE_URL = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

/** 路径表。与 config/routes.json 一致。 */
const ROUTES = {
  bootstrap: "/v1/mpk-bootstrap",
  quotes: "/v1/gpwwvvew-deevda",
  metals: "/v1/mkkzprqp-vvndte",
  fx: "/v1/tqzxvnrk-lzbor",
  fields: "/v1/rtkbmvxw-pflqs",
} as const;

/** X25519 SPKI DER 前缀，raw 公钥 → KeyObject 时要拼上。 */
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

interface Envelope {
  v: 1;
  kid: string;
  c: string;
  ts: number;
}

/** 从服务端公钥表里挑一把（现在只有一把，先不搞轮换）。 */
function pickKey(keys: { kid: string; publicKey: string }[]): { kid: string; publicKey: string } {
  const key = keys[0];
  if (!key) throw new Error("bootstrap 没有返回任何公钥");
  return key;
}

/**
 * 派生会话密钥 —— 与服务端 crypto.ts 完全一致。
 *
 * salt 是固定常量，info 按方向区分。请求与响应用不同密钥，
 * 密文不能跨方向挪用。
 */
function deriveSessionKey(
  clientPrivateKey: KeyObject,
  serverPublicRaw: Buffer,
  direction: "request" | "response",
): Buffer {
  const shared = diffieHellman({
    privateKey: clientPrivateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, serverPublicRaw]),
      format: "der",
      type: "spki",
    }),
  });
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from("metalpricekit/v1", "utf8"),
      Buffer.from(`metalpricekit/v1/${direction}`, "utf8"),
      32,
    ),
  );
}

/** 解开信封。布局：nonce(12) || ciphertext || tag(16)。 */
function openEnvelope(envelope: Envelope, sessionKey: Buffer, aad: string): string {
  const raw = Buffer.from(envelope.c, "base64");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", sessionKey, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** 带客户端公钥请求一次，并解开响应。 */
async function call(
  path: string,
  clientPubB64: string,
  sessionKey: Buffer,
  method = "GET",
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "x-mpk-ck": clientPubB64 },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  const body = JSON.parse(text) as Envelope & Record<string, unknown>;
  if (res.headers.get("x-mpk-encrypted") !== "1") return body;
  const aad = `${method}\n${path}\n${body.kid}`;
  return JSON.parse(openEnvelope(body, sessionKey, aad));
}

async function main(): Promise<void> {
  console.log(`目标：${BASE_URL}`);

  const bootRes = await fetch(`${BASE_URL}${ROUTES.bootstrap}`);
  if (!bootRes.ok) throw new Error(`bootstrap 失败：${bootRes.status}`);
  const boot = (await bootRes.json()) as {
    v: number;
    algorithm: string;
    keys: { kid: string; publicKey: string }[];
  };
  console.log(`bootstrap：v=${boot.v} 算法=${boot.algorithm} 公钥数=${boot.keys.length}`);

  const serverKey = pickKey(boot.keys);
  const clientKp = generateKeyPairSync("x25519");
  const clientPubDer = clientKp.publicKey.export({ format: "der", type: "spki" });
  const clientPubRaw = clientPubDer.subarray(clientPubDer.length - 32);
  const clientPubB64 = clientPubRaw.toString("base64");
  const sessionKey = deriveSessionKey(
    clientKp.privateKey,
    Buffer.from(serverKey.publicKey, "base64"),
    "response",
  );

  const quotes = (await call(ROUTES.quotes, clientPubB64, sessionKey)) as {
    marketStatus: string;
    quotes: { code: string; price: number; changeRate: number }[];
  };
  console.log(`行情：${quotes.quotes.length} 个品种，marketStatus=${quotes.marketStatus}`);
  for (const q of quotes.quotes) {
    console.log(`  ${q.code}  ${q.price}  ${(q.changeRate * 100).toFixed(2)}%`);
  }

  const metals = (await call(ROUTES.metals, clientPubB64, sessionKey)) as {
    metals: { code: string; baseUnit: string; scale: number }[];
  };
  console.log(`品种字典：${metals.metals.map((m) => `${m.code}(${m.baseUnit})`).join(" ")}`);

  const fx = (await call(ROUTES.fx, clientPubB64, sessionKey)) as {
    base: string;
    rates: Record<string, number>;
  };
  console.log(`汇率：base=${fx.base} 币种数=${Object.keys(fx.rates).length} CNY=${fx.rates["CNY"]}`);

  const fields = (await call(ROUTES.fields, clientPubB64, sessionKey)) as Record<string, unknown>;
  console.log(`通用字段：${Object.keys(fields).join(", ")}`);

  console.log("自检通过：加解密链路正常。");
}

main().catch((err) => {
  console.error(`自检失败：${(err as Error).message}`);
  process.exit(1);
});
