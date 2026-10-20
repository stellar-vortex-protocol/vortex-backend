/**
 * AbuseModule — provides the streaming abuse detector.
 *
 * Exported providers:
 *  - AbuseScoreService    (Redis-backed sliding-window scorer)
 *  - AllowlistService     (Postgres-backed API-key / address / IP allowlisting, issue #605)
 *  - AbuseDetectorGuard   (NestJS guard for intent-mutation routes)
 *  - ChallengeVerifier    (PoW + captcha challenge verification, issue #606)
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
    AbuseScoreService,
    AllowlistService,
    AbuseDetectorGuard,
    ChallengeVerifier,
    SignatureNonceService,
  ],
  exports: [AbuseScoreService, AllowlistService, AbuseDetectorGuard, ChallengeVerifier],
})
export class AbuseModule {}
