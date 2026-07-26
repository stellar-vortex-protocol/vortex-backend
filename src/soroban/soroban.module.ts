import { Module } from "@nestjs/common";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";

@Module({
  controllers: [SorobanController],
  providers: [SorobanService, SignerService],
  exports: [SorobanService, SignerService],
})
export class SorobanModule {}
