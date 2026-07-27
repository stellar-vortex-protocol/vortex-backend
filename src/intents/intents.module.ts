import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { SolversModule } from "../solvers/solvers.module";
import { IntentsRepository, InMemoryIntentsRepository } from "./intents.repository";

@Module({
  imports: [SolversModule],
  controllers: [IntentsController],
  providers: [
    IntentsService,
    IntentsGateway,
    IntentsSweeperService,
    {
      provide: IntentsRepository,
      useClass: InMemoryIntentsRepository,
    },
  ],
  exports: [IntentsService, IntentsRepository],
})
export class IntentsModule {}

