import { Module } from "@nestjs/common";
import { RateLimitModule } from "../rate-limit/rate-limit.module";
import { ApiKeyController } from "./api-key.controller";
import { ApiKeyService } from "./api-key.service";
import { PrismaApiKeysRepository } from "./prisma-api-keys.repository";
import { TieredThrottleGuard } from "../rate-limit/tiered-throttle.guard";

/**
 * API key tiers and distributed rate limiting (issue #441).
 *
 * Provides the key lifecycle service, the admin endpoints, and the tiered
 * throttle guard that replaces the legacy per-process global IP throttle.
 */
@Module({
  imports: [RateLimitModule],
  controllers: [ApiKeyController],
  providers: [PrismaApiKeysRepository, ApiKeyService, TieredThrottleGuard],
  // Re-export RateLimitModule so consumers (e.g. AppModule's APP_GUARD)
  // can resolve DistributedRateLimiter when they instantiate TieredThrottleGuard.
  exports: [ApiKeyService, TieredThrottleGuard, RateLimitModule],
})
export class ApiKeysModule {}
