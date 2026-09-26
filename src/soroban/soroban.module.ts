import { Module } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { FeeEscalationPolicy } from "./fee-escalation-policy";
import { ChannelPoolService } from "./channel-pool.service";
import { SolversModule } from "../solvers/solvers.module";

@Module({
  imports: [SolversModule],
  controllers: [SorobanController],
  providers: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    TxConfirmationService,
    FeeEscalationPolicy,
    ChannelPoolService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    TxConfirmationService,
    FeeEscalationPolicy,
    ChannelPoolService,
  ],
})
export class SorobanModule {}
