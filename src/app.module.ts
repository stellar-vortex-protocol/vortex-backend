import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
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
import { AbuseModule } from "./abuse/abuse.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { ApiKeysModule } from "./auth/api-keys/api-keys.module";
import { Sep10Module } from "./auth/sep10/sep10.module";
import { TieredThrottleGuard } from "./auth/rate-limit/tiered-throttle.guard";

@Module({
  imports: [
    // ThrottlerModule stays for the per-user intent guard (#45) and the
    // per-route @Throttle decorators (quote). The GLOBAL IP throttle it used
    // to provide is replaced by the tiered, distributed TieredThrottleGuard
    // (issue #441) — see the APP_GUARD provider below.
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
    // Issue #441 — API key tiers + distributed rate limiting.
    ApiKeysModule,
    // Issue #442 — SEP-10 challenge auth: challenge/token endpoints plus the
    // key material the WS gateway and JWT guards use to verify issued tokens.
    Sep10Module,
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
    AbuseModule,
    HealthModule,
    TokensModule,
    IntentsModule,
    SolversModule,
    StatsModule,
    // Serves GET /api/v1/analytics/* (ADR 0001). Defaults to the in-memory
    // store; ANALYTICS_STORE=timescale selects TimescaleDB.
    AnalyticsModule,
    SorobanModule,
    RoutingModule,
    TreasuryModule,
    GovernanceModule,
  ],
  controllers: [],
  providers: [
    // Issue #441 — tiered, distributed rate limit replaces the legacy
    // per-process global IP throttle. Anonymous requests are limited to the
    // `public` tier (100/min per IP — unchanged); API-key requests are limited
    // by their tier. Enforced by the Redis-backed DistributedRateLimiter with
    // a bounded local fallback, so a Redis outage never means unlimited.
    {
      provide: APP_GUARD,
      useClass: TieredThrottleGuard,
    },
  ],
})
export class AppModule {}
