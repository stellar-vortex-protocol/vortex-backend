/**
 * Read-only client for the on-chain settlement contract.
 *
 * Uses `simulateTransaction` to call view functions (get_intent, get_state)
 * without ever submitting a transaction. This is safe at any time — simulation
 * never mutates ledger state.
 *
 * Used by ReconcilerService to read the canonical on-chain intent state and
 * diff it against Postgres.
 *
 * @module soroban/contracts/settlement.client
 */

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
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { AppConfig } from "../../config/configuration";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OnChainIntentState =
  | "open"
  | "accepted"
  | "filled"
  | "cancelled"
  | "expired"
  | "slashed"
  | "unknown";

export interface OnChainIntent {
  intentId: string;
  user: string;
  solver: string | null;
  state: OnChainIntentState;
  srcAmount: bigint;
  minDstAmount: bigint;
  fillAmount: bigint | null;
  deadline: bigint;
}

export interface SimulationResult<T> {
  ok: true;
  value: T;
  /** Raw simulation result for debugging. */
  rawReturnValue: xdr.ScVal;
}

export type SimulationError = {
  ok: false;
  error: string;
  /** "not_found" when the contract returns a None/null (intent doesn't exist on-chain). */
  reason: "not_found" | "simulation_error" | "decode_error" | "not_configured";
};

const NETWORK_PASSPHRASE: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

/**
 * Maps the raw contract state string/symbol to our canonical `OnChainIntentState`.
 */
function mapContractState(raw: unknown): OnChainIntentState {
  const s = String(raw ?? "").toLowerCase();
  switch (s) {
    case "open":      return "open";
    case "accepted":  return "accepted";
    case "filled":    return "filled";
    case "cancelled": return "cancelled";
    case "expired":   return "expired";
    case "slashed":   return "slashed";
    default:          return "unknown";
  }
}

@Injectable()
export class SettlementClient {
  private readonly logger = new Logger(SettlementClient.name);
  private readonly server: SorobanRpc.Server;
  private readonly contractId: string;
  private readonly networkPassphrase: string;

  constructor(configService: ConfigService<AppConfig, true>) {
    const rpcUrl = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.server = new SorobanRpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
    this.contractId = configService.get("stellar.settlementContractId", { infer: true });
    const network = configService.get("stellar.network", { infer: true });
    this.networkPassphrase = NETWORK_PASSPHRASE[network];
  }

  /** True when a settlement contract ID is configured. */
  get isConfigured(): boolean {
    return this.contractId.length > 0;
  }

  /**
   * Read the intent record from the settlement contract for `intentId`.
   *
   * Uses a simulation against a throw-away ephemeral account so no real
   * account with a sequence number is needed for read-only calls.
   *
   * Returns `SimulationError` with `reason: "not_found"` when the contract
   * returns None (the intent does not exist on-chain).
   */
  async getIntent(
    intentId: string,
  ): Promise<SimulationResult<OnChainIntent> | SimulationError> {
    if (!this.isConfigured) {
      return { ok: false, error: "SETTLEMENT_CONTRACT_ID not configured", reason: "not_configured" };
    }

    try {
      const ephemeralKeypair = Keypair.random();
      const account = await this.server.getAccount(ephemeralKeypair.publicKey()).catch(() => {
        // Build a synthetic account-like object with sequence 0 for simulation.
        // simulateTransaction does not validate the account exists on ledger.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {
          id: ephemeralKeypair.publicKey(),
          sequence: "0",
          accountId() { return ephemeralKeypair.publicKey(); },
          sequenceNumber() { return "0"; },
          incrementSequenceNumber() { return; },
        } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      });

      const contract = new Contract(this.contractId);
      const operation = contract.call(
        "get_intent",
        nativeToScVal(intentId, { type: "string" }),
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
        const errStr = simulation.error;
        if (errStr.includes("not_found") || errStr.includes("None")) {
          return { ok: false, error: `Intent ${intentId} not found on-chain`, reason: "not_found" };
        }
        return { ok: false, error: `Simulation error: ${errStr}`, reason: "simulation_error" };
      }

      const successSim = simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse;
      if (!successSim.result?.retval) {
        return { ok: false, error: "Simulation returned no retval", reason: "not_found" };
      }

      const retval = successSim.result.retval;
      const decoded = this.decodeIntentRetval(retval, intentId);
      return { ok: true, value: decoded, rawReturnValue: retval };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`[settlement-client] getIntent failed for ${intentId}: ${error}`);
      return { ok: false, error, reason: "simulation_error" };
    }
  }

  /**
   * Batch-read intents from the contract with bounded concurrency.
   *
   * @param intentIds  Intent IDs to read.
   * @param concurrency Maximum number of parallel simulations. Defaults to 5.
   */
  async getManyIntents(
    intentIds: string[],
    concurrency = 5,
  ): Promise<Map<string, SimulationResult<OnChainIntent> | SimulationError>> {
    const results = new Map<string, SimulationResult<OnChainIntent> | SimulationError>();
    const queue = [...intentIds];

    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);
      const settled = await Promise.allSettled(
        batch.map((id) => this.getIntent(id)),
      );
      for (let i = 0; i < batch.length; i++) {
        const s = settled[i];
        results.set(
          batch[i],
          s.status === "fulfilled"
            ? s.value
            : { ok: false, error: String((s as PromiseRejectedResult).reason), reason: "simulation_error" },
        );
      }
    }

    return results;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private decodeIntentRetval(retval: xdr.ScVal, intentId: string): OnChainIntent {
    const native = scValToNative(retval) as Record<string, unknown>;

    return {
      intentId,
      user:         String(native["user"] ?? ""),
      solver:       native["solver"] ? String(native["solver"]) : null,
      state:        mapContractState(native["state"] ?? native["status"]),
      srcAmount:    BigInt(String(native["src_amount"] ?? native["srcAmount"] ?? 0)),
      minDstAmount: BigInt(String(native["min_dst_amount"] ?? native["minDstAmount"] ?? 0)),
      fillAmount:   native["fill_amount"] != null
                      ? BigInt(String(native["fill_amount"] ?? native["fillAmount"] ?? 0))
                      : null,
      deadline:     BigInt(String(native["deadline"] ?? 0)),
    };
  }
}
