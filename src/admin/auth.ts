//
//  auth.ts
//  MetalPriceKit Server
//  后台会话鉴权。
//
//  为什么和客户端 token 完全分开：
//  客户端 token 是「匿名用户身份」，几乎人手一个，而且是匿名发出去的；
//  后台口令是「运营权限」，全站就一把。
//  两者放进同一个体系，客户端 token 一旦泄漏就等于把后台敞开。
//  所以后台走独立口令 + 独立 cookie，不共用任何存储与签发逻辑。
//
//  会话是无状态的：cookie 值 = 签发时间 + HMAC 签名。
//  不落库 —— 后台就一两个人用，为这个建表不值得。
//  HMAC 的密钥用管理口令本身：口令一改，所有旧会话立刻失效。
//

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/** 会话 cookie 名。与客户端 token 完全无关。 */
export const ADMIN_COOKIE = "mpk_admin";

/** 会话有效期 7 天。过期了重新输口令即可。 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AdminAuth {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * 校验口令。
   *
   * 先各自做一次 SHA-256 再定长比较 —— 直接比原串的话，
   * 长度不同会提前返回，响应时间会泄露「口令长度是多少」。
   */
  verifyPassword(candidate: string): boolean {
    const a = createHash("sha256").update(candidate, "utf8").digest();
    const b = createHash("sha256").update(this.token, "utf8").digest();
    return timingSafeEqual(a, b);
  }

  /** 签发一个会话。返回 cookie 值。 */
  issue(): string {
    const issuedAt = Date.now().toString(36);
    return `${issuedAt}.${this.sign(issuedAt)}`;
  }

  /** 会话是否有效：签名对得上、且没过期。 */
  isValid(session: string | null): boolean {
    if (!session) return false;
    const dot = session.indexOf(".");
    if (dot <= 0) return false;

    const issuedAt = session.slice(0, dot);
    const signature = session.slice(dot + 1);
    const expected = this.sign(issuedAt);

    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;

    const ts = Number.parseInt(issuedAt, 36);
    if (!Number.isFinite(ts)) return false;
    const age = Date.now() - ts;
    // age < 0 意味着「签发时间在未来」：时钟回拨或伪造，直接判无效。
    return age >= 0 && age < SESSION_TTL_MS;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.token).update(`admin-session:${payload}`).digest("base64url");
  }

  /** 从请求里读出会话值。 */
  readSession(req: Request): string | null {
    const header = req.header("cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== ADMIN_COOKIE) continue;
      return decodeURIComponent(part.slice(eq + 1));
    }
    return null;
  }

  /** 写会话 cookie。 */
  setCookie(res: Response, secure: boolean): void {
    res.setHeader(
      "Set-Cookie",
      serializeCookie(ADMIN_COOKIE, this.issue(), {
        httpOnly: true,
        sameSite: "Strict",
        secure,
        path: "/admin",
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      }),
    );
  }

  /** 清会话 cookie。 */
  clearCookie(res: Response): void {
    res.setHeader(
      "Set-Cookie",
      serializeCookie(ADMIN_COOKIE, "", {
        httpOnly: true,
        sameSite: "Strict",
        secure: false,
        path: "/admin",
        maxAgeSeconds: 0,
      }),
    );
  }
}

/**
 * 手写 cookie 序列化。
 *
 * 不引 cookie 库：这个服务只有这一个 cookie 要写，
 * 为此加一个依赖不值得。
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: {
    httpOnly: boolean;
    sameSite: "Strict" | "Lax";
    secure: boolean;
    path: string;
    maxAgeSeconds: number;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, `Max-Age=${opts.maxAgeSeconds}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
