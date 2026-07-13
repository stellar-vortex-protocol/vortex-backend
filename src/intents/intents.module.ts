import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { SolversModule } from "../solvers/solvers.module";

@Module({
  imports: [SolversModule],
  controllers: [IntentsController],
  providers: [IntentsService, IntentsGateway, IntentsSweeperService],
  exports: [IntentsService],
})
export class IntentsModule {}
