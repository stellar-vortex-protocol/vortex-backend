/**
 * AbuseModule — provides the streaming abuse detector.
 *
 * Exported providers:
 *  - AbuseScoreService  (Redis-backed sliding-window scorer)
 *  - AllowlistService   (API-key / address / IP allowlisting)
 *  - AbuseDetectorGuard (NestJS guard for intent-mutation routes)
 *
 * Marked @Global() so guards can be injected in any module without re-importing
 * AbuseModule in each feature module.
 */

import { Global, Module } from "@nestjs/common";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import { AbuseDetectorGuard } from "./abuse-detector.guard";
import { AbuseController } from "./abuse.controller";

@Global()
@Module({
  controllers: [AbuseController],
  providers: [AbuseScoreService, AllowlistService, AbuseDetectorGuard],
  exports: [AbuseScoreService, AllowlistService, AbuseDetectorGuard],
})
export class AbuseModule {}
