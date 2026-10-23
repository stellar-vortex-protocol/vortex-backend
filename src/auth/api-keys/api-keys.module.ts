import { Module } from "@nestjs/common";
import { RateLimitModule } from "../rate-limit/rate-limit.module";
import { SolverCredentialsModule } from "../solver-credentials/solver-credentials.module";
import { ApiKeyController } from "./api-key.controller";
import { PublicApiKeyController } from "./public-api-key.controller";
import { ApiKeyService } from "./api-key.service";
import { PrismaApiKeysRepository } from "./prisma-api-keys.repository";
import { TieredThrottleGuard } from "../rate-limit/tiered-throttle.guard";
import {
  SIGNUP_TOKEN_STORE,
  SignupTokenStore,
  InMemorySignupTokenStore,
  RedisSignupTokenStore,
} from "./signup-token.store";

/**
 * API key tiers and distributed rate limiting (issue #441).
 *
 * Provides the key lifecycle service, the admin endpoints, the public
 * self-service signup endpoints, and the tiered throttle guard that replaces
 * the legacy per-process global IP throttle.
 */
@Module({
  imports: [RateLimitModule, SolverCredentialsModule],
  controllers: [ApiKeyController, PublicApiKeyController],
  providers: [
    PrismaApiKeysRepository,
    ApiKeyService,
    TieredThrottleGuard,
    {
      provide: SIGNUP_TOKEN_STORE,
      useFactory: (): SignupTokenStore => {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
          return new RedisSignupTokenStore(redisUrl);
        }
        return new InMemorySignupTokenStore();
      },
    },
  ],
  // Re-export RateLimitModule so consumers (e.g. AppModule's APP_GUARD)
  // can resolve DistributedRateLimiter when they instantiate TieredThrottleGuard.
  // Export the signup token store so tests can override it.
  exports: [
    ApiKeyService,
    TieredThrottleGuard,
    RateLimitModule,
    SIGNUP_TOKEN_STORE,
  ],
})
export class ApiKeysModule {}