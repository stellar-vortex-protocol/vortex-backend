import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { SolversModule } from "../solvers/solvers.module";
import { RoutingModule } from "../routing/routing.module";
import { TokensModule } from "../tokens/tokens.module";

@Module({
  imports: [SolversModule, RoutingModule, TokensModule],
import { SorobanModule } from "../soroban/soroban.module";
import { EventIngestionService } from "../soroban/event-ingestion.service";

@Module({
  imports: [SolversModule, SorobanModule],
  controllers: [IntentsController],
  providers: [IntentsService, IntentsGateway, IntentsSweeperService, EventIngestionService],
  exports: [IntentsService],
})
export class IntentsModule {}

