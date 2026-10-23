import { Global, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { InMemorySolverFillsRepository, SOLVER_FILLS_REPOSITORY } from "./solver-fills.repository";
import { PrismaSolverFillsRepository } from "./prisma-solver-fills.repository";

/**
 * Per-fill metrics store (issue #417). `@Global()` because it sits between
 * IntentsModule (writes rows inside fill/failure transitions) and
 * SolversModule (reads stats), which already import each other.
 *
 * Fill rows live next to the intents they describe, so the adapter follows
 * INTENTS_PERSISTENCE: Postgres when intents are in Postgres (and the rows
 * can share their transaction), in-memory otherwise.
 */
@Global()
@Module({
  providers: [
    {
      provide: SOLVER_FILLS_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        (process.env.INTENTS_PERSISTENCE ?? "memory") === "prisma"
          ? new PrismaSolverFillsRepository(prisma)
          : new InMemorySolverFillsRepository(),
    },
  ],
  exports: [SOLVER_FILLS_REPOSITORY],
})
export class SolverFillsModule {}
