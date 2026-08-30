import { Module } from "@nestjs/common";
import { SolversController } from "./solvers.controller";
import { SolversService } from "./solvers.service";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { PrismaSolversRepository } from "./prisma-solvers.repository";
import { PrismaService } from "../prisma/prisma.service";

@Module({
  controllers: [SolversController],
  providers: [
    // Select the persistence adapter based on SOLVERS_PERSISTENCE env var.
    // SOLVERS_PERSISTENCE=prisma  → PrismaSolversRepository (production/staging)
    // SOLVERS_PERSISTENCE=memory  → InMemorySolversRepository (default, dev/test)
    //
    // Swap this binding (and only this binding) to change the storage backend —
    // SolversService and everything above it stay unchanged.
    {
      provide: SOLVERS_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const adapter = process.env.SOLVERS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaSolversRepository(prisma);
        }
        return new InMemorySolversRepository();
      },
    },
    SolversService,
  ],
  exports: [SolversService],
})
export class SolversModule {}
