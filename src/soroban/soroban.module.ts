import { Module } from "@nestjs/common";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";

@Module({
  controllers: [SorobanController],
  providers: [SorobanService, SignerService, StellarTxService],
  exports: [SorobanService, SignerService, StellarTxService],
})
export class SorobanModule {}
