import { Module, OnModuleInit, forwardRef } from "@nestjs/common";
import { SolversController } from "./solvers.controller";
import { SolverGriefingController } from "./solver-griefing.controller";
import { SolversService } from "./solvers.service";
import { ReputationService } from "./reputation.service";
import { SolverGriefingService } from "./solver-griefing.service";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { PrismaSolversRepository } from "./prisma-solvers.repository";
import { PrismaService } from "../prisma/prisma.service";
import { IntentsModule } from "../intents/intents.module";
import { SolverCredentialsModule } from "../auth/solver-credentials/solver-credentials.module";
import { ConfigModule } from "@nestjs/config";
import { MetricsService } from "../metrics/metrics.service";

@Module({
  imports: [forwardRef(() => IntentsModule), SolverCredentialsModule, ConfigModule],
  controllers: [SolversController, SolverGriefingController],
  providers: [
    // Select the persistence adapter based on SOLVERS_PERSISTENCE env var.
    {
      provide: SOLVERS_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const adapter = process.env.SOLVERS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaSolversRepository(prisma);
        }
        return new InMemorySolversRepository();
      },
    },
    SolversService,
    ReputationService,
    // Anti-griefing enforcement engine (issue #453).
    SolverGriefingService,
  ],
  exports: [SolversService, ReputationService, SolverGriefingService],
})
export class SolversModule implements OnModuleInit {
  constructor(
    private readonly griefingService: SolverGriefingService,
    private readonly metricsService: MetricsService,
  ) {}

  /**
   * Wire MetricsService into SolverGriefingService after both providers are
   * initialised.  MetricsModule is @Global() so it is always available; we
   * inject it here rather than in SolverGriefingService's constructor to avoid
   * a circular-module dependency (Metrics → Solvers → Metrics).
   */
  onModuleInit(): void {
    this.griefingService.setMetrics(this.metricsService);
  }
}
