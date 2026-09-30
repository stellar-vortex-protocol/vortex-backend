import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { InMemoryAnalyticsStore, TimescaleAnalyticsStore } from "./analytics.store";
import { ANALYTICS_STORE } from "./analytics.tokens";

@Module({
  controllers: [AnalyticsController],
  providers: [
    // Select the analytics backend: ANALYTICS_STORE=timescale → TimescaleDB
    // continuous aggregates; otherwise the in-memory store (dev/tests).
    {
      provide: ANALYTICS_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const backend = process.env.ANALYTICS_STORE ?? "memory";
        return backend === "timescale" ? new TimescaleAnalyticsStore(prisma) : new InMemoryAnalyticsStore();
      },
    },
    AnalyticsService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
