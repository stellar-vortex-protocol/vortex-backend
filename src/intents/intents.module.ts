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
  controllers: [IntentsController],
  providers: [IntentsService, IntentsGateway, IntentsSweeperService],
  exports: [IntentsService],
})
export class IntentsModule {}
