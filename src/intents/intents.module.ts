import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { SolversModule } from "../solvers/solvers.module";
import { RoutingModule } from "../routing/routing.module";
import { TokensModule } from "../tokens/tokens.module";
import { SorobanModule } from "../soroban/soroban.module";
import { EventIngestionService } from "../soroban/event-ingestion.service";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";

@Module({
  imports: [SolversModule, RoutingModule, TokensModule, SorobanModule],
  controllers: [IntentsController],
  providers: [
    // Select the persistence adapter based on INTENTS_PERSISTENCE env var.
    // INTENTS_PERSISTENCE=prisma  → PrismaIntentsRepository (production/staging)
    // INTENTS_PERSISTENCE=memory  → InMemoryIntentsRepository (default, dev/test)
    {
      provide: INTENTS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService<AppConfig, true>, prisma: PrismaService) => {
        const adapter = process.env.INTENTS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaIntentsRepository(prisma);
        }
        return new InMemoryIntentsRepository();
      },
    },
    IntentsService,
    IntentsGateway,
    IntentsSweeperService,
    EventIngestionService,
  ],
  exports: [IntentsService, IntentsGateway],
})
export class IntentsModule {}
