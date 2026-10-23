/**
 * AbuseModule — provides the streaming abuse detector.
 *
 * Exported providers:
 *  - AbuseScoreService    (Redis-backed sliding-window scorer)
 *  - AllowlistService     (Postgres-backed API-key / address / IP allowlisting, issue #605)
 *  - AbuseDetectorGuard   (NestJS guard for intent-mutation routes)
 *  - AccountAgeService    (cached Horizon account-age lookup for `new_address`)
 *  - ChallengeVerifier    (PoW + captcha challenge verification, issue #606)
 *
 * Rule thresholds are tunable at runtime through `GET/PATCH/DELETE
 * /api/v1/abuse/rules[/:signal]` (admin, `X-Admin-Key`). Overrides persist in
 * Redis (`vortex:abuse:config`) via the ABUSE_RULES_STORE provider and take
 * precedence over `ABUSE_<RULE>_*` env vars, which take precedence over
 * DEFAULT_ABUSE_RULES. See AbuseScoreService for details.
 *
 * AbuseController adds:
 *  - Admin allowlist CRUD endpoints (issue #605)
 *  - Self-service "my score / my audit" endpoints (issue #607)
 *
 * Marked @Global() so guards can be injected in any module without re-importing
 * AbuseModule in each feature module.
 *
 * PrismaService and ConfigService are @Global() providers supplied by
 * PrismaModule and NestJS ConfigModule respectively, so they do not need to be
 * re-declared here — NestJS will inject them automatically.
 */

import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";
import { ABUSE_RULES_STORE, RedisAbuseRulesStore } from "./abuse-rules";
import { AccountAgeService } from "./account-age.service";
import { SignatureNonceService } from "../common/signature-nonce.service";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import { AbuseDetectorGuard } from "./abuse-detector.guard";
import { ChallengeVerifier } from "./challenge-verifier";
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
    ChallengeVerifier,
    SignatureNonceService,
  ],
  exports: [
    AbuseScoreService,
    AllowlistService,
    AccountAgeService,
    AbuseDetectorGuard,
    ChallengeVerifier,
  ],
})
export class AbuseModule {}
