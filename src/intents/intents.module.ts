import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsSseController } from "./intents-sse.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsMaintenanceJobs } from "./intents-maintenance.jobs";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { IntentCapabilityIndex } from "./solver-intent-matcher";
import { backplaneProvider } from "./backplane/backplane.factory";
import { backplaneHealthIndicator } from "./backplane/backplane-health.provider";
import { IntentFeedService } from "./feed/intent-feed.service";
import { Backplane, WS_BACKPLANE } from "./backplane/backplane.types";
import { SolversModule } from "../solvers/solvers.module";
import { SolversService } from "../solvers/solvers.service";
import { MetricsService } from "../metrics/metrics.service";
import { RoutingModule } from "../routing/routing.module";
import { TokensModule } from "../tokens/tokens.module";
import { SorobanModule } from "../soroban/soroban.module";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { GovernanceModule } from "../governance/governance.module";
import { AbuseModule } from "../abuse/abuse.module";
import { SignatureNonceService } from "../common/signature-nonce.service";
import { EvmSignatureVerifier } from "../common/evm-signature";
import { AuctionTickerService } from "../auctions/auction-ticker.service";
import { FillVerifierService } from "../soroban/fill-verifier.service";

@Module({
  // Both SolversModule and SorobanModule import IntentsModule back, so both
  // edges of each cycle must be deferred — a bare import resolves to `undefined`
  // when the peer module is still mid-initialization (AppModule reaches
  // SorobanModule through HealthModule before IntentsModule has finished).
  // `forwardRef` on the SorobanModule import mirrors the one in SorobanModule:
  // the two modules need each other (ShadowService here, IntentsService there).
  imports: [
    forwardRef(() => SolversModule),
    RoutingModule,
    TokensModule,
    forwardRef(() => SorobanModule),
    GovernanceModule,
  ],
  controllers: [IntentsController, IntentsSseController],
  controllers: [IntentsController],
  providers: [
    // Select the persistence adapter based on INTENTS_PERSISTENCE env var.
    // INTENTS_PERSISTENCE=prisma  → PrismaIntentsRepository (production/staging)
    // INTENTS_PERSISTENCE=memory  → InMemoryIntentsRepository (default, dev/test)
    {
      provide: INTENTS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService<AppConfig, true>, prisma: PrismaService) => {
        const adapter = process.env.INTENTS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaIntentsRepository(prisma);
        }
        return new InMemoryIntentsRepository();
      },
    },
    IntentsService,
    SignatureNonceService,
    EvmSignatureVerifier,
    AuctionTickerService,
    FillVerifierService,
    IntentCapabilityIndex,
    backplaneProvider,
    // IntentFeedService is provided via a factory so its optional constructor
    // parameters are not resolved positionally by Nest's injector.
    {
      provide: IntentFeedService,
      inject: [
        IntentsService,
        SolversService,
        IntentCapabilityIndex,
        { token: MetricsService, optional: true },
        ConfigService,
        { token: WS_BACKPLANE, optional: true },
      ],
      useFactory: (
        intentsService: IntentsService,
        solversService: SolversService,
        intentIndex: IntentCapabilityIndex,
        metricsService: MetricsService | undefined,
        config: ConfigService<AppConfig, true>,
        backplane: Backplane | undefined,
      ) =>
        new IntentFeedService(intentsService, solversService, intentIndex, metricsService, config, backplane),
    },
    IntentsGateway,
    backplaneHealthIndicator,
    IntentsSweeperService,
    IntentsMaintenanceJobs,
    // Note: EventIngestionService is provided by SorobanModule (imported above)
    // and exported from there — no re-declaration needed here.
  ],
  exports: [IntentsService, IntentsGateway, IntentCapabilityIndex, IntentFeedService],
})
export class IntentsModule {}
