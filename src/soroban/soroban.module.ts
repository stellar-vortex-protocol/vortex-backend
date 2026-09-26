import { forwardRef, Module } from "@nestjs/common";
import { EventIngestionService } from "./event-ingestion.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { BackfillService } from "./backfill.service";
import { ReconcilerService } from "./reconciler.service";
import { SettlementClient } from "./contracts/settlement.client";
import { SolversModule } from "../solvers/solvers.module";
import { IntentsModule } from "../intents/intents.module";

/**
 * DI token for the shared EventDecoderRegistry instance.
 * Both EventIngestionService and BackfillService share the same registry so
 * their stats aggregate correctly in tests and observability.
 */
export const EVENT_DECODER_REGISTRY = Symbol("EVENT_DECODER_REGISTRY");

@Module({
  imports: [
    SolversModule,
    forwardRef(() => IntentsModule),
  ],
  controllers: [SorobanController],
  providers: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    SettlementClient,
    ReconcilerService,
    EventIngestionService,
    BackfillService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    EventIngestionService,
    SettlementClient,
    ReconcilerService,
    BackfillService,
  ],
})
export class SorobanModule {}
