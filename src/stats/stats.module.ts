import { Module } from "@nestjs/common";
import { StatsController } from "./stats.controller";
import { StatsService } from "./stats.service";
import { IntentsModule } from "../intents/intents.module";
import { SolversModule } from "../solvers/solvers.module";

@Module({
  imports: [IntentsModule, SolversModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
