import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../../config/configuration";
import { DistributedRateLimiter, RATE_LIMIT_REDIS } from "./distributed-rate-limiter";
import { RateLimitRedis } from "./rate-limit-result";

/**
 * Provides the distributed rate limiter (issue #441).
 *
 * The Redis connection is created lazily from REDIS_URL and is optional —
 * when Redis is unavailable the limiter falls back to a bounded local window.
 * The connection uses `enableOfflineQueue: false` so commands fail fast
 * during an outage and the fallback engages immediately rather than queueing.
 */
@Module({
  providers: [
    {
      // Null when RATE_LIMIT_REDIS_URL is empty, which makes the limiter use its
      // bounded local window from the first request instead of opening a doomed
      // connection and logging an outage on every request. Deployments that want
      // the global quota must set RATE_LIMIT_REDIS_URL (REDIS_URL is the default
      // so an existing Redis-backed deployment keeps distributed limiting).
      provide: RATE_LIMIT_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): RateLimitRedis | null => {
        const url = config.get("rateLimitRedisUrl", { infer: true });
        if (!url) return null;
        return new Redis(url, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: true,
        }) as unknown as RateLimitRedis;
      },
    },
    DistributedRateLimiter,
  ],
  exports: [DistributedRateLimiter],
})
export class RateLimitModule {}
