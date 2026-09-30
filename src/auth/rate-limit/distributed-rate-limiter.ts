import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { RateLimitResult } from "./rate-limit-result";
import { RateLimitRedis } from "./rate-limit-result";
import { RedisRateLimitStore } from "./redis-rate-limit.store";
import { LocalRateLimitStore } from "./local-rate-limit.store";

/** Injection token for the rate limiter's Redis connection. */
export const RATE_LIMIT_REDIS = Symbol("RATE_LIMIT_REDIS");

/**
 * Distributed rate limiter (issue #441).
 *
 * Primary path: a Redis sliding window shared by every replica, so the quota
 * is global — N replicas do NOT each get their own limit.
 *
 * Fallback path: when Redis is unreachable, a bounded in-memory sliding window
 * enforces the SAME limit per process. This keeps the system safe (never
 * unlimited) at the cost of per-replica accounting during the outage.
 *
 * The fallback is engaged only on a Redis error; a successful Redis response
 * is always authoritative.
 */
@Injectable()
export class DistributedRateLimiter {
  private readonly logger = new Logger(DistributedRateLimiter.name);
  private readonly redisStore?: RedisRateLimitStore;
  private readonly localStore = new LocalRateLimitStore();
  private redisHealthy = true;

  constructor(
    @Optional() @Inject(RATE_LIMIT_REDIS) redis: RateLimitRedis | null,
    config: ConfigService<AppConfig, true>,
  ) {
    // The Redis client is optional: without one (or with Redis down) the
    // limiter still enforces the local fallback.
    if (redis) {
      this.redisStore = new RedisRateLimitStore(redis);
    }
    // Prune the local fallback periodically so it cannot grow unbounded.
    const pruneMs = config.get("rateLimitLocalPruneMs", { infer: true }) ?? 60_000;
    setInterval(() => this.localStore.prune(Date.now(), 60_000), pruneMs).unref();
  }

  /**
   * Consume one unit from the sliding window for `key`.
   *
   * @returns the rate-limit result, or `null` when the limiter itself failed
   *   in a way that cannot be trusted — callers must treat `null` as
   *   "deny" (fail closed), never as "allow".
   */
  async consume(key: string, limit: number, windowMs: number, nowMs = Date.now()): Promise<RateLimitResult | null> {
    if (this.redisStore) {
      try {
        const result = await this.redisStore.consume(key, windowMs, limit, nowMs);
        this.markRedisHealthy();
        return result;
      } catch (err) {
        this.markRedisDown(err);
      }
    }
    // Redis unavailable — fall back to the bounded local limiter.
    return this.localStore.consume(key, windowMs, limit, nowMs);
  }

  /** Whether the Redis path is currently healthy (for metrics / health). */
  get isRedisHealthy(): boolean {
    return this.redisHealthy;
  }

  private markRedisHealthy(): void {
    if (!this.redisHealthy) {
      this.redisHealthy = true;
      this.logger.warn("Rate-limiter Redis connection recovered");
    }
  }

  private markRedisDown(err: unknown): void {
    if (this.redisHealthy) {
      this.redisHealthy = false;
      this.logger.error(
        `Rate-limiter Redis unavailable, falling back to local limiter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
