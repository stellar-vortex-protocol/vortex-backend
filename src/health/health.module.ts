import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { DatabaseHealthService } from "./database-health.service";
import { SorobanModule } from "../soroban/soroban.module";

// PrismaModule is registered as @Global() in AppModule so PrismaService is
// available here without an explicit import.
@Module({
  imports: [SorobanModule],
  controllers: [HealthController],
  providers: [DatabaseHealthService],
})
export class HealthModule {}
