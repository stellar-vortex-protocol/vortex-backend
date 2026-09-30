import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { TokensModule } from "./tokens/tokens.module";
import { IntentsModule } from "./intents/intents.module";
import { MetricsModule } from "./metrics/metrics.module";
import { SolversModule } from "./solvers/solvers.module";
import { StatsModule } from "./stats/stats.module";
import { SorobanModule } from "./soroban/soroban.module";
import { RoutingModule } from "./routing/routing.module";
import { KillSwitchModule } from "./killswitch/killswitch.module";
import { PrismaModule } from "./prisma/prisma.module";
import { TreasuryModule } from "./treasury/treasury.module";
import { GovernanceModule } from "./governance/governance.module";
import { LeaderElectionModule } from "./common/leader-election";
import { AdminModule } from "./admin/admin.module";
import { JobsModule } from "./jobs/jobs.module";
import { FlagsModule } from "./flags/flags.module";
import { GuardianStateModule } from "./governance/guardian-state.service";
import { DatasetsModule } from "./datasets/datasets.module";
import { DocsModule } from "./docs/docs.module";

@Module({
  imports: [
    // Issue #44 — global rate limit: 100 requests per 60 s per IP
    ThrottlerModule.forRoot([
      {
        name: "global",
        ttl: 60_000, // ms
        limit: 100,
      },
    ]),
    // Enable scheduled tasks (cron jobs)
    ScheduleModule.forRoot(),
    ConfigModule,
    PrismaModule,
    // @Global() — registers MetricsService / MetricsInterceptor / MetricsController
    // for the whole app. Must be imported once in the root module or the global
    // providers never become visible to other modules (e.g. IntentsSweeperService)
    // and Nest fails to resolve MetricsService at boot.
    MetricsModule,
    // Emergency pause control plane (issue #477). @Global() so KillSwitchGuard
    // can gate write handlers in any module.
    KillSwitchModule,
    // Leader election must be initialised before any worker module so that
    // LeaderElectionService is available when workers call registerWorker()
    // in their onModuleInit hooks.
    LeaderElectionModule.forRoot(),
    // Issues #494/#495/#507 — admin RBAC + audit, job queue, runtime flags,
    // guardian-derived policy state.
    AdminModule,
    JobsModule,
    FlagsModule,
    GuardianStateModule,
    HealthModule,
    TokensModule,
    IntentsModule,
    SolversModule,
    StatsModule,
    SorobanModule,
    RoutingModule,
    TreasuryModule,
    GovernanceModule,
    // Serves GET /docs/ws — the WebSocket AsyncAPI document (issue #456).
    DocsModule,
  ],
  controllers: [],
  providers: [
    // Apply the IP-based throttle globally to every route
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
