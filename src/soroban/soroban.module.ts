import { Module } from "@nestjs/common";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { StellarTxService } from "./stellar-tx.service";

@Module({
  controllers: [SorobanController],
  providers: [SorobanService, StellarTxService],
  exports: [SorobanService, StellarTxService],
})
export class SorobanModule {}
