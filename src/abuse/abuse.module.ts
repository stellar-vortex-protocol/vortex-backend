/**
 * AbuseModule — provides the streaming abuse detector.
 *
 * Exported providers:
 *  - AbuseScoreService  (Redis-backed sliding-window scorer)
 *  - AllowlistService   (API-key / address / IP allowlisting)
 *  - AbuseDetectorGuard (NestJS guard for intent-mutation routes)
 *  - AccountAgeService  (cached Horizon account-age lookup for `new_address`)
 *
 * Rule thresholds are tunable at runtime through `GET/PATCH/DELETE
 * /api/v1/abuse/rules[/:signal]` (admin, `X-Admin-Key`). Overrides persist in
 * Redis (`vortex:abuse:config`) via the ABUSE_RULES_STORE provider and take
 * precedence over `ABUSE_<RULE>_*` env vars, which take precedence over
 * DEFAULT_ABUSE_RULES. See AbuseScoreService for details.
 *
 * Marked @Global() so guards can be injected in any module without re-importing
 * AbuseModule in each feature module.
 */

import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";
import { ABUSE_RULES_STORE, RedisAbuseRulesStore } from "./abuse-rules";
import { AccountAgeService } from "./account-age.service";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import { AbuseDetectorGuard } from "./abuse-detector.guard";
import { AbuseController } from "./abuse.controller";

@Global()
@Module({
  controllers: [AbuseController],
  providers: [
    {
      provide: ABUSE_RULES_STORE,
      inject: [ConfigService],
      // A dedicated connection: WATCH/MULTI state is per connection, so rule
      // updates stay isolated from the scorer's counter traffic.
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new RedisAbuseRulesStore(
          new Redis(config.get("redisUrl", { infer: true }), {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            lazyConnect: true,
          }).on("error", () => undefined),
        ),
    },
    AbuseScoreService,
    AllowlistService,
    AccountAgeService,
    AbuseDetectorGuard,
  ],
  exports: [AbuseScoreService, AllowlistService, AccountAgeService, AbuseDetectorGuard],
})
export class AbuseModule {}
