import { Module } from "@nestjs/common";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";

@Module({
  controllers: [SorobanController],
  providers: [SorobanService],
  exports: [SorobanService],
})
export class SorobanModule {}
