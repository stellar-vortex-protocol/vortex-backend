import { RateLimitResult } from "./rate-limit-result";
import { RateLimitRedis } from "./rate-limit-result";
import { SLIDING_WINDOW_SCRIPT, SlidingWindowTuple } from "./sliding-window-script";

/**
 * Redis-backed sliding-window rate-limit store (issue #441).
 *
 * All state lives in a single Redis sorted set per key, mutated only by the
 * atomic Lua script in {@link SLIDING_WINDOW_SCRIPT}. Because the script is
 * atomic, every replica shares one global quota — N replicas do NOT get
 * N × limit.
 */
export class RedisRateLimitStore {
  constructor(private readonly redis: RateLimitRedis) {}

  /**
   * Consume one unit from the sliding window for `key`.
   *
   * @param key       Rate-limit bucket (e.g. `apiKey:abc123` or `ip:1.2.3.4`).
   * @param windowMs  Sliding-window size in milliseconds.
   * @param limit     Maximum requests allowed within the window.
   * @param nowMs     Current time in milliseconds (injected for testability).
   */
  async consume(key: string, windowMs: number, limit: number, nowMs: number): Promise<RateLimitResult> {
    const raw = await this.redis.eval(SLIDING_WINDOW_SCRIPT, 1, key, windowMs, limit, nowMs);
    const [allowed, remaining, resetAt] = this.toTuple(raw);
    return {
      allowed: allowed === 1,
      limit,
      remaining,
      resetAt,
    };
  }

  private toTuple(raw: unknown): SlidingWindowTuple {
    if (Array.isArray(raw) && raw.length >= 3) {
      return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
    }
    // A malformed response must never be interpreted as "unlimited".
    throw new Error("Rate limiter returned a malformed response");
  }
}
