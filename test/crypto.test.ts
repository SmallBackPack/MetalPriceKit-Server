//
//  crypto.test.ts
//  MetalPriceKit Server
//  加密层的往返测试。
//
//  这些断言同时是客户端实现的规格说明 ——
//  Swift 侧照着同样的步骤实现就能解开服务端返回的密文。
//

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { buildAad, deriveSessionKey, isEnvelope, open, publicOf, seal } from "../src/crypto.ts";

/** 模拟客户端：生成自己的 X25519 密钥对。 */
function makeClientKeyPair() {
  const kp = generateKeyPairSync("x25519");
  const raw = kp.publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: kp.privateKey,
    publicKey: raw.subarray(raw.length - 32),
  };
}

/** 模拟服务端：只有一把长期私钥。 */
function makeServerKeyPair() {
  const privateKey = randomBytes(32);
  return { kid: "k1", privateKey, publicKey: publicOf(privateKey) };
}

test("客户端与服务端各自派生出的会话密钥一致", () => {
  const server = makeServerKeyPair();
  const client = makeClientKeyPair();

  const serverSide = deriveSessionKey(server, client.publicKey, "response");
  // 客户端侧等价操作：ECDH(serverPub, clientPriv) → HKDF
  const shared = diffieHellman({
    privateKey: client.privateKey,
    publicKey: createPublicFromRaw(server.publicKey),
  });
  const clientSide = Buffer.from(
    hkdfSync("sha256", shared, Buffer.from("metalpricekit/v1", "utf8"),
      Buffer.from("metalpricekit/v1/response", "utf8"), 32),
  );

  assert.deepEqual(serverSide, clientSide);
});

test("密文可以被正确解开，还原出原文", () => {
  const server = makeServerKeyPair();
  const client = makeClientKeyPair();
  const key = deriveSessionKey(server, client.publicKey, "response");
  const aad = buildAad("GET", "/v1/gpwwvvew-deevda", "k1");

  const original = JSON.stringify({ serverTime: "2026-11-04T18:56:11.083Z", quotes: [] });
  const envelope = seal(original, key, "k1", aad);

  assert.equal(envelope.v, 1);
  assert.equal(envelope.kid, "k1");
  assert.ok(!envelope.c.includes("serverTime"), "密文里不应出现明文片段");
  assert.equal(open(envelope, key, aad), original);
});

test("AAD 绑定了方法与路径，换个接口就解不开", () => {
  const server = makeServerKeyPair();
  const client = makeClientKeyPair();
  const key = deriveSessionKey(server, client.publicKey, "response");

  const envelope = seal("secret", key, "k1", buildAad("GET", "/v1/a", "k1"));

  assert.throws(
    () => open(envelope, key, buildAad("GET", "/v1/b", "k1")),
    /unable to authenticate|Unsupported state/i,
  );
  assert.throws(
    () => open(envelope, key, buildAad("POST", "/v1/a", "k1")),
    /unable to authenticate|Unsupported state/i,
  );
});

test("密文被篡改会解密失败，而不是返回垃圾数据", () => {
  const server = makeServerKeyPair();
  const client = makeClientKeyPair();
  const key = deriveSessionKey(server, client.publicKey, "response");
  const aad = buildAad("GET", "/v1/a", "k1");

  const envelope = seal("hello", key, "k1", aad);
  const raw = Buffer.from(envelope.c, "base64");
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; // 翻转认证标签的一位
  const tampered = { ...envelope, c: raw.toString("base64") };

  assert.throws(() => open(tampered, key, aad));
});

test("不同客户端派生出不同的会话密钥", () => {
  const server = makeServerKeyPair();
  const clientA = makeClientKeyPair();
  const clientB = makeClientKeyPair();

  const keyA = deriveSessionKey(server, clientA.publicKey, "response");
  const keyB = deriveSessionKey(server, clientB.publicKey, "response");

  assert.notDeepEqual(keyA, keyB);
});

test("请求方向与响应方向的密钥不同", () => {
  const server = makeServerKeyPair();
  const client = makeClientKeyPair();

  const reqKey = deriveSessionKey(server, client.publicKey, "request");
  const resKey = deriveSessionKey(server, client.publicKey, "response");

  assert.notDeepEqual(reqKey, resKey);
});

test("isEnvelope 能正确识别信封", () => {
  assert.equal(isEnvelope({ v: 1, kid: "k1", c: "abc", ts: 1 }), true);
  assert.equal(isEnvelope({ v: 1, kid: "k1" }), false);
  assert.equal(isEnvelope({ hello: "world" }), false);
  assert.equal(isEnvelope(null), false);
  assert.equal(isEnvelope("string"), false);
});

/** 把 raw 公钥包装成 Node KeyObject（测试里模拟客户端拿服务端公钥做 ECDH）。 */
function createPublicFromRaw(raw: Buffer) {
  const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}
