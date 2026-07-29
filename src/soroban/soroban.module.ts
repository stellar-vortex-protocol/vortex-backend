import { Module } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";

@Module({
  controllers: [SorobanController],
  providers: [SorobanService, EventIngestionService],
  exports: [SorobanService, EventIngestionService],
})
export class SorobanModule {}
