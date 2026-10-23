import { Global, Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DatabaseHealthService } from "./database-health.service";
import { HealthIndicatorRegistry } from "./health-indicator.registry";
import { coreHealthIndicators } from "./health-indicators.provider";
import { SorobanModule } from "../soroban/soroban.module";
import {
  HEALTH_TIMELINE_STORE,
  InMemoryHealthTimelineStore,
  PrismaHealthTimelineStore,
} from "./health-timeline.store";

// PrismaModule is registered as @Global() in AppModule so PrismaService is
// available here without an explicit import. @Global so other modules can
// register their own indicators on HealthIndicatorRegistry (issue #492).
//
// The health timeline store defaults to the in-memory ring buffer so no
// database is required in dev/test. Set HEALTH_PERSISTENCE=prisma to opt in
// to the durable, cross-replica Prisma-backed adapter (issue #689).
const healthTimelineStoreProvider = {
  provide: HEALTH_TIMELINE_STORE,
  useFactory: (): InMemoryHealthTimelineStore | PrismaHealthTimelineStore => {
    if (process.env.HEALTH_PERSISTENCE === "prisma") {
      return new PrismaHealthTimelineStore();
    }
    return new InMemoryHealthTimelineStore();
  },
};

@Global()
@Module({
  imports: [SorobanModule],
  controllers: [HealthController],
  providers: [
    DatabaseHealthService,
    healthTimelineStoreProvider,
    HealthIndicatorRegistry,
    coreHealthIndicators,
  ],
  exports: [HealthIndicatorRegistry],
})
export class HealthModule {}