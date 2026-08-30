import { forwardRef, Module } from "@nestjs/common";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { EventIngestionService } from "./event-ingestion.service";
import { IntentsModule } from "../intents/intents.module";

@Module({
  imports: [forwardRef(() => IntentsModule)],
  controllers: [SorobanController],
  providers: [SorobanService, SignerService, StellarTxService, EventIngestionService],
  exports: [SorobanService, SignerService, StellarTxService, EventIngestionService],
})
export class SorobanModule {}
