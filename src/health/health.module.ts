import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DatabaseHealthService } from "./database-health.service";

// PrismaModule is registered as @Global() in AppModule so PrismaService is
// available here without an explicit import.
@Module({
  controllers: [HealthController],
  providers: [DatabaseHealthService],
})
export class HealthModule {}
