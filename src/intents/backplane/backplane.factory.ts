import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../../config/configuration";
import { MetricsService } from "../../metrics/metrics.service";
import { Backplane, WS_BACKPLANE } from "./backplane.types";
import { MemoryBackplane } from "./memory.backplane";
import { RedisBackplane, RedisLike } from "./redis.backplane";

/** Nest provider selecting the WS backplane from WS_BACKPLANE (issue #454). */
export const backplaneProvider = {
  provide: WS_BACKPLANE,
  inject: [ConfigService, { token: MetricsService, optional: true }],
  useFactory: (config: ConfigService<AppConfig, true>, metrics?: MetricsService): Backplane => {
    if (config.get("wsBackplane", { infer: true }) !== "redis") return new MemoryBackplane();
    const url = config.get("redisUrl", { infer: true });
    return new RedisBackplane({
      // Offline queue off: commands fail fast during an outage and the
      // backplane retries them itself, preserving order.
      createClient: () =>
        new Redis(url, { maxRetriesPerRequest: null, enableOfflineQueue: false }) as unknown as RedisLike,
      metrics: metrics && {
        observePublish: (s) => metrics.wsBackplanePublishDuration.observe(s),
        incDropped: (reason) => metrics.wsBackplaneDropped.inc({ reason }),
        setConnected: (c) => metrics.wsBackplaneConnected.set(c ? 1 : 0),
      },
    });
  },
};
