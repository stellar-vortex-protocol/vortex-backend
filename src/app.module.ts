import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { TokensModule } from "./tokens/tokens.module";
import { IntentsModule } from "./intents/intents.module";
import { SolversModule } from "./solvers/solvers.module";
import { StatsModule } from "./stats/stats.module";
import { SorobanModule } from "./soroban/soroban.module";
import { RoutingModule } from "./routing/routing.module";
import { PrismaModule } from "./prisma/prisma.module";
import { MetricsModule } from "./metrics/metrics.module";

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
    // Global event bus for domain events (TxConfirmed, TxFailed, TxExpired, etc.)
    EventEmitterModule.forRoot({ wildcard: false, delimiter: ".", global: true }),
    ConfigModule,
    PrismaModule,
    MetricsModule,
    HealthModule,
    TokensModule,
    IntentsModule,
    SolversModule,
    StatsModule,
    SorobanModule,
    RoutingModule,
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
