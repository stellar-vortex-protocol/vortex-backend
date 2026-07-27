import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { SolversModule } from "../solvers/solvers.module";
import { INTENTS_REPOSITORY } from "./intents.repository";
import { InMemoryIntentsRepository } from "./in-memory-intents.repository";

@Module({
  imports: [SolversModule],
  controllers: [IntentsController],
  providers: [
    // Bind the in-memory adapter to the repository token.
    // Swap this binding (and only this binding) to use a different storage
    // backend — IntentsService and everything above it stay unchanged.
    {
      provide: INTENTS_REPOSITORY,
      useClass: InMemoryIntentsRepository,
    },
    IntentsService,
    IntentsGateway,
    IntentsSweeperService,
  ],
  exports: [IntentsService],
})
export class IntentsModule {}
