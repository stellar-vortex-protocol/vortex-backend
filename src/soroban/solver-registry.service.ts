import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SignerService } from "./signer.service";

const NETWORK_PASSPHRASE: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

export interface SlashParams {
  solverAddress: string;
  intentId: string;
  reason: string;
}

export interface SlashResult {
  /** true only if a transaction was actually broadcast to the network. */
  submitted: boolean;
  /** true if we got far enough to run a (network, non-mutating) simulation. */
  simulated: boolean;
  txHash?: string;
  detail: string;
  /**
   * true when the result is from a dry-run (ONCHAIN_DRY_RUN=true).
   * A dry-run always has submitted=false; it may or may not have simulated=true
   * depending on whether the contract is configured.
   */
  dryRun: boolean;
}

/**
 * Client for the on-chain solver-registry contract's penalty path.
 *
 * There is no deployed solver-registry contract or confirmed function
 * signature yet (tracked separately — issue #23 wires solver acceptance to
 * this same contract). Until that lands, this service simulates the call
 * it *would* make and never submits — safe by construction, since
 * SorobanRpc's simulateTransaction never mutates ledger state. It also
 * fails closed to a pure no-op whenever the registry contract ID or the
 * backend's signing key isn't configured, which is the default in every
 * environment today (see src/config/env.validation.ts).
 *
 * Wiring an actual submit path is deliberately left for once issue #23
 * confirms the real contract interface and the dry-run flag (issue #260 / #35)
 * exists to stage the rollout — see docs/runbooks/onchain-cutover.md.
 */
@Injectable()
export class SolverRegistryService {
  private readonly logger = new Logger(SolverRegistryService.name);
  private readonly contractId: string;
  private readonly signingKey: string;
  private readonly networkPassphrase: string;
  private readonly server: SorobanRpc.Server;
  private readonly dryRun: boolean;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly signerService?: SignerService,
  ) {
    this.contractId = configService.get("stellar.solverRegistryContractId", { infer: true });
    this.signingKey = configService.get("stellar.signingKey", { infer: true });
    const network = configService.get("stellar.network", { infer: true });
    this.networkPassphrase = NETWORK_PASSPHRASE[network];
    const rpcUrl = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.dryRun = configService.get("onchainDryRun", { infer: true });
  }

  get isConfigured(): boolean {
    return this.contractId.length > 0 && this.signingKey.length > 0;
  }

  async slashSolver(params: SlashParams): Promise<SlashResult> {
    // ── Dry-run short-circuit (ONCHAIN_DRY_RUN=true) ────────────────────────
    // When dry-run is on, log what *would* be submitted and return immediately
    // without touching the network. This is the reference implementation for
    // "dry-run output" that all other write paths should mirror.
    if (this.dryRun) {
      this.logger.log(
        `[dry-run] would slash solver=${params.solverAddress} intent=${params.intentId} ` +
        `reason="${params.reason}" — ONCHAIN_DRY_RUN=true, no transaction submitted`,
      );
      return {
        submitted: false,
        simulated: false,
        dryRun: true,
        detail: "ONCHAIN_DRY_RUN=true — simulated log only, no transaction submitted",
      };
    }

    // ── Live path (ONCHAIN_DRY_RUN=false) ───────────────────────────────────
    if (!this.isConfigured) {
      const detail =
        "SOLVER_REGISTRY_CONTRACT_ID or SOROBAN_SIGNING_KEY not configured — no-op";
      this.logger.log(
        `[solver-registry] would slash solver=${params.solverAddress} intent=${params.intentId} reason="${params.reason}" (${detail})`,
      );
      return { submitted: false, simulated: false, dryRun: false, detail };
    }

    try {
      const sourceKeypair = this.signerService
        ? Keypair.fromSecret(this.signingKey)
        : Keypair.fromSecret(this.signingKey);
      const account = await this.server.getAccount(sourceKeypair.publicKey());
      const contract = new Contract(this.contractId);

      const operation = contract.call(
        "slash",
        Address.fromString(params.solverAddress).toScVal(),
        nativeToScVal(params.intentId, { type: "string" }),
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        const detail = `simulation failed: ${simulation.error}`;
        this.logger.error(
          `[solver-registry] slash simulation errored for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
        );
        return { submitted: false, simulated: true, dryRun: false, detail };
      }

      // TODO: Once issue #23 confirms the real contract interface, replace
      // the simulate-only path below with an actual signed submission:
      //   const prepared = SorobanRpc.assembleTransaction(tx, simulation);
      //   sourceKeypair.sign(prepared);
      //   const result = await this.server.sendTransaction(prepared);
      const detail =
        "simulated only — live submission is gated pending issue #23 (confirmed contract " +
        "interface); set ONCHAIN_DRY_RUN=false and wire the submit path to go live";
      this.logger.log(
        `[solver-registry] simulated slash tx for solver=${params.solverAddress} intent=${params.intentId} (${detail})`,
      );
      return { submitted: false, simulated: true, dryRun: false, detail };
    } catch (err) {
      // Issue #300 — the SDK may include serialized transaction/XDR details in
      // thrown errors; do not log the signing key or any raw secret here.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[solver-registry] slash call errored for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
      );
      return { submitted: false, simulated: false, dryRun: false, detail };
    }
  }
}
