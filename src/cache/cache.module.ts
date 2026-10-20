import { Global, Logger, Module, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { CacheService } from "./cache.service";
import { InMemoryCacheInvalidationBus, RedisCacheInvalidationBus } from "./cache-invalidation.bus";
import { MemoryCacheStore } from "./memory-cache.store";
import { RedisCacheStore } from "./redis-cache.store";

/**
 * Read-path cache (issue #414). `@Global()` so the services owning cached
 * reads (tokens, solvers, stats) and the services emitting invalidating
 * events (intents, solvers, admin tokens) can inject {@link CacheService}
 * without new module edges.
 *
 * CACHE_DRIVER selects the store:
 *   memory — per-process store (default; dev/test/single replica)
 *   redis  — shared Redis store + Redis pub/sub invalidation (REDIS_URL)
 *   off    — every read goes to the database
 */
@Global()
@Module({
  providers: [
    {
      provide: CacheService,
      inject: [ConfigService, { token: MetricsService, optional: true }],
      useFactory: (config: ConfigService<AppConfig, true>, metrics?: MetricsService) => {
        const cache = config.get("cache", { infer: true });
        const sink = metrics
          ? {
              request: (keyspace: string, result: string) => metrics.cacheRequests.inc({ keyspace, result }),
              invalidation: (keyspace: string, source: string) =>
                metrics.cacheInvalidations.inc({ keyspace, source }),
            }
          : undefined;
        if (cache.driver === "redis") {
          const url = config.get("redisUrl", { infer: true });
          return new CacheService(RedisCacheStore.connect(url), new RedisCacheInvalidationBus(url), {
            metrics: sink,
            jitter: cache.ttlJitter,
          });
        }
        return new CacheService(new MemoryCacheStore(), new InMemoryCacheInvalidationBus(), {
          enabled: cache.driver !== "off",
          metrics: sink,
          jitter: cache.ttlJitter,
        });
      },
    },
  ],
  exports: [CacheService],
})
export class CacheModule implements OnModuleInit {
  private readonly logger = new Logger(CacheModule.name);

  constructor(@Optional() private readonly cache?: CacheService) {}

  onModuleInit(): void {
    // Not awaited: an unreachable Redis must not block boot. Reads already
    // degrade to the database; invalidations from peers resume on reconnect.
    this.cache?.listen().catch((err: Error) => {
      this.logger.warn(`[cache] invalidation subscriber failed to start: ${err.message}`);
    });
  }
}
