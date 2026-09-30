import { Global, Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DatabaseHealthService } from "./database-health.service";
import { HealthIndicatorRegistry } from "./health-indicator.registry";
import { coreHealthIndicators } from "./health-indicators.provider";
import { SorobanModule } from "../soroban/soroban.module";

// PrismaModule is registered as @Global() in AppModule so PrismaService is
// available here without an explicit import. @Global so other modules can
// register their own indicators on HealthIndicatorRegistry (issue #492).
@Global()
@Module({
  imports: [SorobanModule],
  controllers: [HealthController],
  providers: [DatabaseHealthService, HealthIndicatorRegistry, coreHealthIndicators],
  exports: [HealthIndicatorRegistry],
})
export class HealthModule {}
