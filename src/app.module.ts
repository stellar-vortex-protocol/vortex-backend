import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { TokensModule } from "./tokens/tokens.module";
import { IntentsModule } from "./intents/intents.module";
import { SolversModule } from "./solvers/solvers.module";
import { StatsModule } from "./stats/stats.module";
import { SorobanModule } from "./soroban/soroban.module";
import { RoutingModule } from "./routing/routing.module";

@Module({
  imports: [
    ConfigModule,
    HealthModule,
    TokensModule,
    IntentsModule,
    SolversModule,
    StatsModule,
    SorobanModule,
    RoutingModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
