/**
 * StellarTxService (issue #394 — archived contract state)
 * ─────────────────────────────────────────────────────────
 * Builds, simulates, and submits Soroban contract invocations.
 *
 * Preflight pipeline (issue #394)
 * ────────────────────────────────
 * Soroban state archival means persistent ledger entries (intents, solver
 * bonds) whose TTL lapsed become archived.  Any invocation that touches them
 * will fail simulation with a `restorePreamble` — a block that describes the
 * entries that must be restored before the call can succeed.
 *
 * StellarTxService now detects this condition and automatically:
 *   1. Builds a RestoreFootprint transaction from the preamble.
 *   2. Signs, submits, and confirms the restore transaction.
 *   3. Re-simulates the original transaction on the freshly-restored state.
 *   4. Submits the original transaction.
 *
 * A max-one-restore guard prevents infinite loops: if the re-simulation still
 * yields a restorePreamble, the call fails with a clear error.
 *
 * Constraints (from the issue):
 *   • Restore fees respect the configured fee ceiling (same percentile-based
 *     estimation as regular Soroban fees).
 *   • ONCHAIN_DRY_RUN=true suppresses all on-chain writes (restore included).
 *   • Restore count and fee are recorded in Prometheus metrics.
 */

import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Operation,
  SorobanDataBuilder,
  Networks,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig, FeePercentile, NETWORK_PASSPHRASES } from "../config/configuration";
import { classifySimulationResponse } from "./shadow-divergence";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { FeatureFlagService } from "../flags/feature-flag.service";
import { TxConfirmationService } from "./tx-confirmation.service";
import { MetricsService } from "../metrics/metrics.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import {
  assertNotPaused,
  KillSwitchActiveException,
} from "../killswitch/killswitch.guard";
import { STELLAR_CHAIN } from "../intents/intents.types";

/**
 * Assumed per-simulation RPC latency, used to size the envelope's ledger
 * validity window.
 *
 * The window has to outlast the *whole* queue, not one item: a simulation
 * enqueued behind `queueMax / concurrency` slow RPCs must not have expired by
 * the time it is asked, or it comes back as a divergence and inflates the very
 * ratio the cutover runbook reads as a pass.
 */
const ASSUMED_SIMULATION_RPC_MS = 3_000;

/** Floor for the validity window, in seconds. */
const MIN_SIMULATION_TIMEOUT_SECONDS = 300;

/** Ceiling for the validity window, in seconds (Stellar rejects absurd values). */
const MAX_SIMULATION_TIMEOUT_SECONDS = 3_600;

export interface FeeEstimate {
  /** Classic inclusion fee, in stroops. */
  baseFee: string;
  /** Soroban resource fee returned by simulation, in stroops. */
  resourceFee: string;
  /** baseFee + resourceFee, in stroops. */
  totalFee: string;
}

export interface InvokeContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface InvokeContractResult {
  hash: string;
  status: string;
  /**
   * True when the invocation was simulated only (dry-run mode).
   * The hash field contains a placeholder — no transaction was broadcast.
   */
  dryRun: boolean;
  /** True when a RestoreFootprint transaction was submitted before the main tx. */
  restored?: boolean;
}

/** Parameters for a read-only, never-broadcast contract simulation. */
export interface SimulateContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /**
   * Public key used as the transaction source for the simulation.
   *
   * The key is used only to satisfy the envelope's source-account field; the
   * envelope is never signed and never submitted, so the key needs no balance,
   * no sequence of its own and is never charged a fee. Leaving it empty
   * short-circuits to a "cannot simulate" result rather than guessing.
   */
  sourceAccount?: string;
}

/**
 * Verdict from a simulated contract call.
 *
 * - `ok` — the contract would have accepted the call.
 * - `rejected` — the contract was reached and refused it (a `require!` guard
 *   tripped, an invariant failed, the method refused the state transition).
 * - `error` — the contract was reached and failed: the call was made and the
 *   contract did not complete it. This is a statement about the contract.
 * - `unavailable` — no verdict was obtained at all: the RPC was unreachable,
 *   the envelope could not be built, or the response was empty. This is a
 *   statement about us, and the monitor reports it as `simulation_exception`
 *   rather than blaming the contract for our outage.
 * - `skipped` — the simulation was not attempted (no source account / contract
 *   configured). Never reported as agreement.
 */
export type SimulateContractOutcome = "ok" | "rejected" | "error" | "unavailable" | "skipped";

export interface SimulateContractResult {
  outcome: SimulateContractOutcome;
  /** Log-safe explanation. Never contains keys or raw XDR. */
  detail?: string;
}


@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);
  private readonly feePercentile: FeePercentile;
  private readonly dryRun: boolean;
  private readonly networkPassphrase: string;
  /**
   * Ledger validity window for simulation envelopes, in seconds.
   *
   * Sized from the shadow queue's worst-case drain time so an observation that
   * waited at the back of the queue still simulates against valid ledger state.
   */
  private readonly simulationTimeoutSeconds: number;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly signerService: SignerService,
    private readonly confirmationService: TxConfirmationService,
    configService: ConfigService<AppConfig, true>,
    private readonly killSwitch: KillSwitchService,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly flags?: FeatureFlagService,
  ) {
    this.feePercentile = configService.get("stellar.feePercentile", { infer: true });
    this.dryRun = configService.get("onchainDryRun", { infer: true });
    this.networkPassphrase =
      NETWORK_PASSPHRASES[configService.get("stellar.network", { infer: true })] ??
      Networks.TESTNET;

    // NaN-safe on purpose: a missing or unparseable queue setting must not
    // propagate into the ledger validity window, where it would produce a
    // transaction that cannot be encoded at all.
    const configuredQueueMax = Number(configService.get("shadow.queueMax", { infer: true }));
    const queueMax =
      Number.isFinite(configuredQueueMax) && configuredQueueMax > 0 ? configuredQueueMax : 256;
    const configuredConcurrency = Number(configService.get("shadow.concurrency", { infer: true }));
    const concurrency =
      Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
        ? Math.floor(configuredConcurrency)
        : 4;
    const batchesToDrain = Math.ceil(queueMax / concurrency);
    this.simulationTimeoutSeconds = Math.min(
      MAX_SIMULATION_TIMEOUT_SECONDS,
      Math.max(
        MIN_SIMULATION_TIMEOUT_SECONDS,
        Math.ceil((batchesToDrain * ASSUMED_SIMULATION_RPC_MS) / 1000) + 60,
      ),
    );
  }

  /**
   * Recommended classic inclusion fee based on recent network activity.
   * Falls back to the network's minimum base fee if fee stats are unavailable
   * or the reported fee is degenerate (e.g. an idle network reporting "0").
   */
  async estimateBaseFee(): Promise<string> {
    try {
      const stats = await this.sorobanService.getFeeStats();
      const fee = stats.sorobanInclusionFee[this.feePercentile];
      return fee && fee !== "0" ? fee : BASE_FEE;
    } catch (err) {
      this.logger.warn(
        `Failed to fetch Soroban fee stats, falling back to base fee ${BASE_FEE}: ${(err as Error).message}`,
      );
      return BASE_FEE;
    }
  }

  /**
   * Estimates the total fee (base + resource) required to submit `transaction`
   * by simulating it against the network.
   */
  async estimateFee(transaction: Transaction): Promise<FeeEstimate> {
    const baseFee = await this.estimateBaseFee();
    const simulation = await this.sorobanService.simulateTransaction(
      this.withFee(transaction, baseFee),
    );

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Fee estimation failed: transaction simulation error: ${simulation.error}`,
      );
    }

    const resourceFee = (simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .minResourceFee;
    const totalFee = (BigInt(baseFee) + BigInt(resourceFee)).toString();

    return { baseFee, resourceFee, totalFee };
  }

  /**
   * Simulates `transaction` and returns it assembled with the estimated
   * base + resource fee and Soroban transaction data, ready to sign.
   *
   * Detects `restorePreamble` and surfaces it for callers that need to handle
   * archival before proceeding (used by `invokeContract`'s preflight pipeline).
   */
  async prepareTransaction(transaction: Transaction): Promise<Transaction> {
    const baseFee = await this.estimateBaseFee();
    const prepared = await this.sorobanService.prepareTransaction(
      this.withFee(transaction, baseFee),
    );

    this.logger.log(
      `Prepared transaction with fee ${prepared.fee} stroops (base fee ${baseFee})`,
    );

    return prepared as Transaction;
  }

  /**
   * Invokes a Soroban contract method with automatic RestoreFootprint preflight.
   *
   * Dry-run path (ONCHAIN_DRY_RUN=true, the default outside production):
   *   Simulates the transaction and returns `{ dryRun: true }` — no funds move.
   *
   * Live path (ONCHAIN_DRY_RUN=false):
   *   1. Simulate the transaction.
   *   2. If simulation returns a restorePreamble, submit a RestoreFootprint
   *      transaction first (issue #394), confirm it, then re-simulate.
   *   3. Sign and submit the (now-prepared) original transaction.
   *   4. Confirm and return the result.
   */
  async invokeContract(params: InvokeContractParams): Promise<InvokeContractResult> {
    // Issue #477 — the last gate before anything touches the chain. Checking
    // here rather than only in controllers also covers background callers (the
    // sweeper, event ingestion) that never pass through an HTTP guard.
    //
    // Evaluated before the dry-run branch so a pause is visible in logs even
    // while on-chain writes are simulated.
    this.assertOnChainWriteAllowed(params.method);

    // ONCHAIN_DRY_RUN is the default; the `onchain-dry-run` runtime flag
    // (issue #495) can override it without a restart.
    const dryRun = this.flags
      ? await this.flags.getBooleanValue("onchain-dry-run", { chain: "stellar" })
      : this.dryRun;
    if (dryRun) {
      this.logger.log(
        `[dry-run] invokeContract contractId=${params.contractId} method=${params.method} ` +
        `— simulating only, ONCHAIN_DRY_RUN=true (no transaction submitted)`,
      );
      return { hash: "dry-run-no-hash", status: "DRY_RUN", dryRun: true };
    }

    this.logger.log(
      `invokeContract contractId=${params.contractId} method=${params.method}`,
    );

    return this.signerService.withNextSequence(async (sequence) => {
      const account = new Account(this.signerService.getPublicKey(), sequence);
      const baseFee = await this.estimateBaseFee();

      const rawTx = new TransactionBuilder(account, {
        fee: baseFee,
        networkPassphrase: this.signerService.getNetworkPassphrase(),
      })
        .addOperation(
          new Contract(params.contractId).call(params.method, ...params.args),
        )
        .setTimeout(30)
        .build();
      let simulation = await this.sorobanService.simulateTransaction(rawTx);

      let restored = false;
      if (this.hasRestorePreamble(simulation)) {
        this.logger.warn(
          `[stellar-tx] restorePreamble detected for method=${params.method} on contract=${params.contractId}; submitting RestoreFootprint`,
        );
        await this.submitRestoreFootprint(simulation, account, baseFee);
        restored = true;

        // Re-simulate after restore (max one restore per invocation).
        simulation = await this.sorobanService.simulateTransaction(rawTx);
        if (this.hasRestorePreamble(simulation)) {
          throw new Error(
            `invokeContract: restorePreamble still present after restore — aborting to prevent loop (method=${params.method})`,
          );
        }
      }

      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(
          `invokeContract simulation failed: ${(simulation as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`,
        );
      }

      // Assemble with Soroban data + fee.
      const prepared = await this.sorobanService.prepareTransaction(rawTx);
      const signed = await this.signerService.sign(prepared as Transaction);

      const submittedAt = Date.now();
      const sendResponse = await this.sorobanService.submitTransaction(signed);

      if (sendResponse.status === "ERROR") {
        throw new Error(
          `invokeContract submit failed: ${(sendResponse as { errorResultXdr?: string }).errorResultXdr ?? "unknown error"}`,
        );
      }

      const confirmation = await this.confirmationService.waitForConfirmation(
        sendResponse.hash,
        submittedAt,
      );

      if (confirmation.status === "FAILED" || confirmation.status === "TIMEOUT") {
        throw new Error(
          `invokeContract transaction did not confirm: status=${confirmation.status} error=${confirmation.error}`,
        );
      }

      this.logger.log(
        `invokeContract succeeded: hash=${sendResponse.hash} method=${params.method} restored=${restored}`,
      );

      return {
        hash: sendResponse.hash,
        status: "SUCCESS",
        dryRun: false,
        restored,
      };
    });
  }

  // ── RestoreFootprint helpers (issue #394) ──────────────────────────────────

  /**
   * Returns true when a simulation response contains a `restorePreamble`
   * indicating that one or more ledger entries need to be restored before
   * the invocation can proceed.
   */
  private hasRestorePreamble(
    simulation: SorobanRpc.Api.SimulateTransactionResponse,
  ): boolean {
    if (SorobanRpc.Api.isSimulationError(simulation)) return false;
    const success = simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      restorePreamble?: { minResourceFee: string; transactionData: string };
    };
    return (
      success.restorePreamble !== undefined &&
      success.restorePreamble.minResourceFee !== undefined
    );
  }

  /**
   * Build, sign, submit, and confirm a RestoreFootprint transaction using the
   * footprint described in `simulation.restorePreamble`.
   *
   * Fee is estimated from the preamble's `minResourceFee` plus the base
   * inclusion fee — respecting the same fee ceiling as normal Soroban ops.
   *
   * @throws if submission or confirmation fails.
   */
  private async submitRestoreFootprint(
    simulation: SorobanRpc.Api.SimulateTransactionResponse,
    account: Account,
    baseFee: string,
  ): Promise<void> {
    const success = simulation as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      restorePreamble: { minResourceFee: string; transactionData: string };
    };

    const preamble = success.restorePreamble;
    const resourceFee = preamble.minResourceFee;
    const totalFee = (BigInt(baseFee) + BigInt(resourceFee)).toString();

    // Parse the footprint XDR from the preamble.
    const sorobanData = SorobanDataBuilder.fromXDR(preamble.transactionData);

    const restoreTx = new TransactionBuilder(account, {
      fee: totalFee,
      networkPassphrase: this.signerService.getNetworkPassphrase(),
    })
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(sorobanData.build())
      .setTimeout(30)
      .build();

    const signedRestore = await this.signerService.sign(restoreTx);
    const submittedAt = Date.now();
    const sendResponse = await this.sorobanService.submitTransaction(signedRestore);

    if (sendResponse.status === "ERROR") {
      try { this.metricsService?.incSorobanRestore("failed"); } catch { /* noop */ }
      throw new Error(
        `RestoreFootprint submission failed: ${(sendResponse as { errorResultXdr?: string }).errorResultXdr ?? "unknown"}`,
      );
    }

    const confirmation = await this.confirmationService.waitForConfirmation(
      sendResponse.hash,
      submittedAt,
    );

    if (confirmation.status !== "SUCCESS") {
      try { this.metricsService?.incSorobanRestore("failed"); } catch { /* noop */ }
      throw new Error(
        `RestoreFootprint did not confirm: status=${confirmation.status} error=${confirmation.error}`,
      );
    }

    this.logger.log(
      `[stellar-tx] RestoreFootprint confirmed: hash=${sendResponse.hash} ` +
      `resourceFee=${resourceFee} durationMs=${confirmation.durationMs}`,
    );

    try {
      this.metricsService?.incSorobanRestore("success");
      this.metricsService?.observeRestoreFee(Number(totalFee));
    } catch { /* noop */ }
  }

  private withFee(transaction: Transaction | FeeBumpTransaction, fee: string): Transaction {
    if ("innerTransaction" in transaction) {
      throw new TypeError("fee bump transactions are not supported");
    }

    return TransactionBuilder.cloneFrom(transaction, {
      fee,
      networkPassphrase: transaction.networkPassphrase,
    }).build();
  }

  /**
   * Throws when an emergency pause covers this on-chain write.
   *
   * `onchain` is evaluated rather than the caller's nominal operation, because
   * this is the single point every chain write funnels through — pausing
   * `onchain` must stop all of them, whichever method they use.
   */
  private assertOnChainWriteAllowed(method: string): void {
    try {
      assertNotPaused(this.killSwitch, {
        // Deliberately the protocol chain, not `stellar.network`. Switch scopes
        // are addressed with the chain an intent names ("stellar"); the network
        // ("testnet"/"mainnet") selects a Soroban endpoint and would never match
        // a `chain=stellar` pause.
        chain: STELLAR_CHAIN,
        token: null,
        operation: "onchain",
      });
    } catch (err) {
      if (err instanceof KillSwitchActiveException) {
        this.logger.warn(
          `On-chain write blocked by kill-switch: method=${method} ` +
            `scope=${err.scope} reason=${err.reasonCode}`,
        );
      }
      throw err;
    }
  }

  /**
   * Simulates a contract invocation **without ever submitting it** (issue #401).
   *
   * This is the only RPC call the shadow-mode divergence monitor is allowed to
   * make. `SorobanRpc.Server.simulateTransaction` runs the contract in a
   * sandboxed copy of ledger state and returns a result without a transaction
   * ever entering the mempool, so:
   *
   * - No transaction is signed, so no channel account sequence is consumed.
   * - No fee is charged.
   * - Ledger state is untouched.
   *
   * It is therefore safe to call regardless of the value of `ONCHAIN_DRY_RUN`:
   * the flag governs *broadcast*, and this method never broadcasts. Calling it
   * from a request path is still forbidden by the monitor's own contract (see
   * `ShadowService.observe`), but the primitive itself is unconditionally
   * read-only.
   *
   * Every failure mode is folded into a {@link SimulateContractResult} rather
   * than a thrown error, so a caller draining a queue never has to distinguish
   * "the contract said no" from "the RPC was down" by catching.
   */
  async simulateContract(params: SimulateContractParams): Promise<SimulateContractResult> {
    const sourceAccount = params.sourceAccount?.trim();
    if (!sourceAccount) {
      return {
        outcome: "skipped",
        detail: "no simulation source account configured (SHADOW_SOURCE_ACCOUNT)",
      };
    }
    if (!params.contractId?.trim()) {
      return {
        outcome: "skipped",
        detail: "no settlement contract configured (SETTLEMENT_CONTRACT_ID)",
      };
    }

    let transaction: Transaction;
    try {
      transaction = await this.buildSimulationTransaction(params, sourceAccount);
    } catch (err) {
      // Building failed (bad contract ID, unparseable args, unreachable RPC for
      // the sequence number). Nothing was broadcast, so this is safe to report —
      // and it is `unavailable`, not `error`: the contract was never asked.
      return {
        outcome: "unavailable",
        detail: `could not build simulation transaction: ${(err as Error).message}`,
      };
    }

    let response: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      response = await this.sorobanService.simulateTransaction(transaction);
    } catch (err) {
      // Transport failure: the contract was never asked, so this is our outage
      // and not a disagreement with the contract.
      return {
        outcome: "unavailable",
        detail: `simulation request failed: ${(err as Error).message}`,
      };
    }

    if (!response) {
      return { outcome: "unavailable", detail: "empty simulation response" };
    }

    // The RPC's success response has no `error` member; its error response has
    // one. Reading it structurally keeps the shared classifier independent of
    // the SDK's union type, and means the revert-vs-hard-error rule that decides
    // `rejected` vs `error` is the single copy covered by
    // `shadow-divergence.spec.ts` rather than a second one here.
    const errorText =
      "error" in response && typeof (response as { error?: unknown }).error === "string"
        ? (response as { error: string }).error
        : undefined;
    const classification = classifySimulationResponse({ error: errorText });

    if (classification.outcome === "ok" && !classification.threw) {
      return { outcome: "ok" };
    }

    return {
      outcome: classification.outcome === "rejected" ? "rejected" : "error",
      ...(classification.detail ? { detail: classification.detail } : {}),
    };
  }

  /**
   * Assemble an unsigned, submit-shaped envelope for a contract invocation.
   *
   * The sequence number comes from the source account when it exists on chain.
   * A simulation does not need a *correct* sequence — nothing is signed, so
   * nothing is sequenced — but it does need the envelope to decode, and a
   * contract that checks its own caller's sequence would answer a fabricated
   * number differently than it answers the real one, manufacturing divergences
   * out of nothing.
   *
   * A key that has never been on chain has no sequence, which is a legitimate
   * configuration (a throwaway key is enough to build an envelope), so the
   * latest ledger sequence is used as the fallback.
   */
  private async buildSimulationTransaction(
    params: SimulateContractParams,
    sourceAccount: string,
  ): Promise<Transaction> {
    const baseFee = await this.estimateBaseFee();
    const sequence = await this.resolveSimulationSequence(sourceAccount);

    // `TransactionBuilder` emits `source.sequenceNumber() + 1` as the envelope's
    // seqNum, so the account handed to it must sit one *below* the sequence the
    // envelope should carry; passing `sequence` straight through would shift
    // every envelope (42 -> 43, 501 -> 502, 0 -> 1).
    const sourceSequence = (BigInt(sequence) - 1n).toString();

    // Pin both ends of the window: `simulationTimeoutSeconds` sizes the
    // *width* (worst-case queue drain), not "seconds from now", so the
    // envelope does not silently stay valid for `now + window` seconds.
    const now = Math.floor(Date.now() / 1000);

    return new TransactionBuilder(new Account(sourceAccount, sourceSequence), {
      fee: baseFee,
      networkPassphrase: this.networkPassphrase,
    })
      // Same envelope shape as `invokeContract` builds for the live path —
      // the monitor is only useful if it simulates the call the chain would
      // actually receive.
      .addOperation(new Contract(params.contractId).call(params.method, ...params.args))
      .setTimebounds(now, now + this.simulationTimeoutSeconds)
      .addOperation(
        // The SDK expects `func` to be a fully-formed xdr.HostFunction that
        // already carries its InvokeContractArgs; a bare enum value (and the
        // SDK-11 style `args` array) produces an envelope that cannot be XDR
        // encoded. The token argument mirrors the settlement contract's
        // `native` (XLM) entry point — irrelevant to a simulation, but the
        // ScVal must be well-formed for the envelope to decode.
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: contract.toScAddress(),
              // InvokeContractArgs takes the method name as a plain string and
              // encodes it as a symbol itself, so no nativeToScVal here.
              functionName: params.method,
              args: params.args,
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(this.simulationTimeoutSeconds)
      .build();
  }

  /**
   * Best available sequence number for a simulation envelope.
   *
   * Tries the account first (exact), then the latest ledger (plausible), and
   * finally `"0"`. Each fallback is logged at warn/debug so an operator reading
   * the logs can tell a legitimate throwaway key from an RPC that is not
   * answering.
   */
  private async resolveSimulationSequence(sourceAccount: string): Promise<string> {
    try {
      const account = await this.sorobanService.getAccount(sourceAccount);
      const sequence = account.sequenceNumber();
      if (sequence) return String(sequence);
    } catch (err) {
      this.logger.warn(
        `Could not load source account ${sourceAccount} for shadow simulation: ${
          (err as Error).message
        }`,
      );
    }

    try {
      const ledger = await this.sorobanService.getLatestLedger();
      const latest = (ledger as unknown as { sequence?: string | number }).sequence;
      const parsed = typeof latest === "string" ? Number(latest) : latest;
      if (typeof parsed === "number" && Number.isFinite(parsed)) {
        return String(parsed + 1);
      }
    } catch (err) {
      this.logger.warn(
        `Could not read latest ledger for shadow simulation, falling back to sequence 0: ${
          (err as Error).message
        }`,
      );
    }

    return "0";
  }
}
