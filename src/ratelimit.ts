//
//  ratelimit.ts
//  MetalPriceKit Server
//  进程内滑动窗口限流。
//
//  契约里定了两档：IP 60 次/分、token 30 次/分。
// 单实例不需要 Redis —— 1000 个 token 的计数器放内存足够，
// 重启后清零也 tolerable（最多误伤一次）。
//
//  为什么必须限流：行情接口是公开的，没有限流的话一个脚本就能
// 打满服务器，顺带把上游那 100 次/月的额度烧光。
//

export interface RateLimitOptions {
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口内允许的最大次数。 */
  max: number;
}

interface Bucket {
  /** 当前窗口起点的时间戳。 */
  windowStart: number;
  /** 当前窗口内的计数。 */
  count: number;
}

/**
 * 固定窗口计数器。
 *
 * 用固定窗口而不是滑动窗口：实现简单、内存可控，代价是窗口边界可能放过
 * 2 倍流量。对「防止脚本跑飞」这个目标来说够用了。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly opts: RateLimitOptions;

  constructor(opts: RateLimitOptions) {
    this.opts = opts;
  }

  /**
   * 记一次请求，返回是否放行。
   * 超限时返回 false，并给出建议的重试等待时间（秒）。
   */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.opts.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      this.sweep(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    bucket.count += 1;
    if (bucket.count > this.opts.max) {
      const waitMs = this.opts.windowMs - (now - bucket.windowStart);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** 清理过期桶，防止 map 无限增长。 */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.opts.windowMs) this.buckets.delete(key);
    }
  }
}
