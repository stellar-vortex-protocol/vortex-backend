import { forwardRef, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventIngestionService } from "./event-ingestion.service";
import { ShadowController } from "./shadow.controller";
import { ShadowService } from "./shadow.service";
import { SorobanController } from "./soroban.controller";
import { SorobanService } from "./soroban.service";
import { SolverRegistryService } from "./solver-registry.service";
import { SignerService } from "./signer.service";
import { StellarTxService } from "./stellar-tx.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { FeeEscalationPolicy } from "./fee-escalation-policy";
import { SolverRegistryEventsService } from "./events/solver-registry-events.service";
import { SIGNER_TOKEN, signerFactory } from "./signers/signer.factory";
import { SolversModule } from "../solvers/solvers.module";
import { MetricsService } from "../metrics/metrics.service";
import { AppConfig } from "../config/configuration";
import { IntentsModule } from "../intents/intents.module";

// MetricsModule is @Global() and registered in AppModule, so the MetricsService
// that ShadowService emits its counters through needs no import here.
@Module({
  // SorobanModule <-> SolversModule <-> IntentsModule (which imports this
  // module) form a CommonJS cycle, so both sides are wrapped in forwardRef.
  // IntentsModule → SorobanModule (IntentsService submits settlement writes)
  // and SorobanModule → IntentsModule (EventIngestionService reconciles
  // intents from on-chain events). SolversModule supplies SolversService to
  // EventIngestionService and, via IntentsModule, also participates in the
  // cycle — so it is deferred too.
  imports: [forwardRef(() => IntentsModule), forwardRef(() => SolversModule)],
  controllers: [SorobanController, ShadowController],
  providers: [
    SorobanService,

    // ── Pluggable signer backend (issue #400) ─────────────────────────────
    // Factory selects LocalKeypairSigner (SIGNER_BACKEND=local, default) or
    // VaultTransitSigner (SIGNER_BACKEND=vault) at bootstrap. All other
    // services inject SignerService and are unaware of the active backend.
    {
      provide: SIGNER_TOKEN,
      inject: [ConfigService, MetricsService],
      useFactory: signerFactory,
    },
    SignerService,

    // ── On-chain tx pipeline (issue #394) ─────────────────────────────────
    TxConfirmationService,
    // Fee-escalation ladder used by TxConfirmationService's durable poller
    // (issue #386): decides when a stuck envelope gets a fee bump.
    FeeEscalationPolicy,
    StellarTxService,

    SolverRegistryService,
    EventIngestionService,

    // ── Solver-registry event ingestion (issue #399) ──────────────────────
    SolverRegistryEventsService,
    // Issue #401 — shadow-mode divergence monitor. Exported so IntentsService
    // can report off-chain transitions to it without importing Soroban internals.
    ShadowService,
  ],
  exports: [
    SorobanService,
    SolverRegistryService,
    SignerService,
    StellarTxService,
    TxConfirmationService,
    EventIngestionService,
    SolverRegistryEventsService,
    ShadowService,
  ],
})
export class SorobanModule {}
