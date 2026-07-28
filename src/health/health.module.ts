import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { SorobanModule } from "../soroban/soroban.module";

@Module({
  imports: [SorobanModule],
  controllers: [HealthController],
})
export class HealthModule {}
