import { RateLimitResult } from "./rate-limit-result";

/**
 * In-memory sliding-window rate-limit store.
 *
 * This is the BOUNDED FALLBACK used when Redis is unavailable (issue #441).
 * It enforces the exact same limit per process — a Redis outage must never
 * turn rate limiting into unlimited access. The trade-off is documented in
 * docs/rate-limits.md: during an outage each replica enforces the limit
 * locally, so the effective global quota is at most N × limit across N
 * replicas, but it is always bounded and never unlimited.
 *
 * The store is bounded: entries are pruned on every consume and keys expire
 * after the window elapses, so memory cannot grow without limit.
 */
export class LocalRateLimitStore {
  private readonly windows = new Map<string, number[]>();

  async consume(key: string, windowMs: number, limit: number, nowMs: number): Promise<RateLimitResult> {
    const cutoff = nowMs - windowMs;
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length < limit) {
      timestamps.push(nowMs);
      this.windows.set(key, timestamps);
      return {
        allowed: true,
        limit,
        remaining: limit - timestamps.length,
        resetAt: nowMs + windowMs,
      };
    }

    // Denied: the window resets when the oldest in-window entry expires.
    const oldest = timestamps[0];
    this.windows.set(key, timestamps);
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: oldest + windowMs,
    };
  }

  /** Drop every expired entry so the map cannot grow unbounded. */
  prune(nowMs: number, windowMs: number): void {
    for (const [key, timestamps] of this.windows) {
      const kept = timestamps.filter((t) => t > nowMs - windowMs);
      if (kept.length === 0) this.windows.delete(key);
      else this.windows.set(key, kept);
    }
  }

  /** Number of tracked keys (for tests / metrics). */
  get size(): number {
    return this.windows.size;
  }
}
