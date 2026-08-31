import { Injectable } from "@nestjs/common";
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
 * confirms the real contract interface and the dry-run flag (issue #35)
 * exists to stage the rollout — see docs/runbooks/onchain-cutover.md.
 */
@Injectable()
export class SolverRegistryService {
  private readonly contractId: string;
  private readonly signingKey: string;
  private readonly networkPassphrase: string;
  private readonly server: SorobanRpc.Server;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.contractId = configService.get("stellar.solverRegistryContractId", { infer: true });
    this.signingKey = configService.get("stellar.signingKey", { infer: true });
    const network = configService.get("stellar.network", { infer: true });
    this.networkPassphrase = NETWORK_PASSPHRASE[network];
    const rpcUrl = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  get isConfigured(): boolean {
    return this.contractId.length > 0 && this.signingKey.length > 0;
  }

  async slashSolver(params: SlashParams): Promise<SlashResult> {
    if (!this.isConfigured) {
      const detail =
        "SOLVER_REGISTRY_CONTRACT_ID or SOROBAN_SIGNING_KEY not configured — no-op";
      console.log(
        `[solver-registry] would slash solver=${params.solverAddress} intent=${params.intentId} reason="${params.reason}" (${detail})`,
      );
      return { submitted: false, simulated: false, detail };
    }

    try {
      const sourceKeypair = Keypair.fromSecret(this.signingKey);
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
        console.error(
          `[solver-registry] slash simulation errored for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
        );
        return { submitted: false, simulated: true, detail };
      }

      const detail =
        "simulated only — live submission is gated pending issue #23 (confirmed contract interface) and issue #35 (dry-run/live-mode toggle)";
      console.log(
        `[solver-registry] simulated slash tx for solver=${params.solverAddress} intent=${params.intentId} (${detail})`,
      );
      return { submitted: false, simulated: true, detail };
    } catch (err) {
      // Issue #300 — the SDK may include serialized transaction/XDR details in
      // thrown errors; do not log the signing key or any raw secret here.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[solver-registry] slash call errored for solver=${params.solverAddress} intent=${params.intentId}: ${detail}`,
      );
      return { submitted: false, simulated: false, detail };
    }
  }
}
