import { Module, forwardRef } from "@nestjs/common";
import { SolversController } from "./solvers.controller";
import { SolversService } from "./solvers.service";
import { AntiGriefingController } from "./anti-griefing.controller";
import { AntiGriefingService } from "./anti-griefing.service";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { PrismaSolversRepository } from "./prisma-solvers.repository";
import { PrismaService } from "../prisma/prisma.service";
import { IntentsModule } from "../intents/intents.module";

@Module({
  imports: [forwardRef(() => IntentsModule)],
  controllers: [SolversController, AntiGriefingController],
  providers: [
    // Select the persistence adapter based on SOLVERS_PERSISTENCE env var.
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
    // Issue #453 — policy engine evaluated by IntentsController.accept and
    // IntentsSweeperService.slashMissedFill, both of which live in
    // IntentsModule and reach it through this module's export.
    AntiGriefingService,
  ],
  exports: [SolversService, AntiGriefingService],
})
export class SolversModule {}
