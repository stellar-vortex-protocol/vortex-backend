import { Module } from "@nestjs/common";
import { SolversController } from "./solvers.controller";
import { SolversService } from "./solvers.service";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";

@Module({
  controllers: [SolversController],
  providers: [
    // Bind the in-memory adapter to the repository token.
    // Swap this binding (and only this binding) to use a different storage
    // backend — SolversService and everything above it stay unchanged.
    {
      provide: SOLVERS_REPOSITORY,
      useClass: InMemorySolversRepository,
    },
    SolversService,
  ],
  exports: [SolversService],
})
export class SolversModule {}
