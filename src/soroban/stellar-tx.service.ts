import { Injectable, Logger } from "@nestjs/common";
import {
  Account,
  BASE_FEE,
  Contract,
  nativeToScVal,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { SignerService } from "./signer.service";
import { SorobanService } from "./soroban.service";

export interface ContractInvocation {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  sequence: string;
  fee?: string;
  timeoutSeconds?: number;
}

export interface SubmitOptions {
  /** Maximum number of submit attempts before giving up. */
  maxAttempts?: number;
  /** Base delay for exponential backoff between attempts, in ms. */
  baseBackoffMs?: number;
  /** Ceiling on the backoff delay, in ms. */
  maxBackoffMs?: number;
  /** How often to poll for a submitted transaction's result, in ms. */
  pollIntervalMs?: number;
  /** How long to keep polling before giving up on confirmation, in ms. */
  pollTimeoutMs?: number;
}

export interface SubmitResult {
  hash: string;
  status: SorobanRpc.Api.GetTransactionStatus;
  response: SorobanRpc.Api.GetSuccessfulTransactionResponse;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 300;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;

/** Thrown once retries are exhausted or the transaction is confirmed as failed on-chain. */
export class SorobanSubmissionError extends Error {
  constructor(
    message: string,
    readonly hash: string | null,
    readonly attempts: number,
    /** True for a definitive on-chain outcome (e.g. FAILED) that must not be retried. */
    readonly terminal = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SorobanSubmissionError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Converts JS values to ScVal via the SDK's type inference, for callers that don't need explicit XDR types. */
export function nativeArgs(...values: unknown[]): xdr.ScVal[] {
  return values.map((value) => nativeToScVal(value));
}

/**
 * Builds and submits Soroban contract-invocation transactions.
 *
 * Submission is not a naive "retry on any error": a transient RPC failure
 * here can mean the transaction was actually accepted by the network before
 * the failure happened (e.g. the response to `sendTransaction` was lost, or
 * a later confirmation poll times out). Blindly resubmitting in that case
 * risks a double submission. So before ever resending, we check the
 * transaction's status by hash — the signed envelope (and therefore its
 * hash) is fixed for the lifetime of one `signAndSubmit` call, only the
 * *attempt* to get it accepted is retried.
 */
@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly signerService: SignerService,
  ) {}

  /**
   * Builds an unsigned contract-invocation transaction against the signer's
   * account, using `invocation.sequence` as the resulting transaction's
   * sequence number (e.g. the value handed out by `SignerService.withNextSequence`).
   */
  async buildContractInvocation(invocation: ContractInvocation): Promise<Transaction> {
    // `Account`'s sequence is the account's *current* sequence, and
    // TransactionBuilder increments it by one for the built tx — so to make
    // the tx land on `invocation.sequence`, the Account must be constructed
    // one behind it.
    const accountSequence = (BigInt(invocation.sequence) - 1n).toString();
    const source = new Account(this.signerService.getPublicKey(), accountSequence);
    const contract = new Contract(invocation.contractId);

    return new TransactionBuilder(source, {
      fee: invocation.fee ?? BASE_FEE,
      networkPassphrase: this.signerService.getNetworkPassphrase(),
    })
      .addOperation(contract.call(invocation.method, ...(invocation.args ?? [])))
      .setTimeout(invocation.timeoutSeconds ?? 30)
      .build();
  }

  /**
   * Reserves the signing account's next sequence number, builds a contract
   * invocation on it, and signs and submits it — all under the same
   * sequence-lock, so this is safe to call concurrently.
   */
  async invokeContract(
    invocation: Omit<ContractInvocation, "sequence">,
    opts?: SubmitOptions,
  ): Promise<SubmitResult> {
    return this.signerService.withNextSequence(async (sequence) => {
      const tx = await this.buildContractInvocation({ ...invocation, sequence });
      return this.signAndSubmit(tx, opts);
    });
  }

  /**
   * Simulates, signs, and submits `tx`, retrying transient submission
   * failures with exponential backoff. Always checks whether the transaction
   * already landed before resending it. Caps attempts and throws
   * `SorobanSubmissionError` with a clear message once exhausted.
   */
  async signAndSubmit(tx: Transaction, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

    const prepared = await this.sorobanService.prepareTransaction(tx);
    const signed = this.signerService.sign(prepared);
    const hash = signed.hash().toString("hex");

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          // Idempotency guard: a prior attempt in this same call may have
          // already been accepted even though it appeared to fail (lost
          // response, poll timeout, etc). Never resend blindly.
          const existing = await this.sorobanService.getTransactionStatus(hash);
          if (existing.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            return this.finalize(existing, hash);
          }
        }

        const sendResult = await this.sorobanService.sendTransaction(signed);
        if (sendResult.status === "ERROR") {
          throw new Error(`Soroban rejected submission: ${JSON.stringify(sendResult.errorResult ?? sendResult.status)}`);
        }

        return await this.pollForResult(hash, opts);
      } catch (err) {
        // A definitive on-chain outcome (e.g. FAILED) is not a transient
        // submission problem — retrying it would just confirm the same
        // failure again, wasting the whole attempt budget.
        if (err instanceof SorobanSubmissionError && err.terminal) throw err;

        lastError = err;
        this.logger.warn(`Soroban submission attempt ${attempt}/${maxAttempts} failed for ${hash}: ${(err as Error).message}`);
        if (attempt === maxAttempts) break;
        await sleep(Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs));
      }
    }

    throw new SorobanSubmissionError(
      `Soroban transaction submission failed after ${maxAttempts} attempts (hash=${hash})`,
      hash,
      maxAttempts,
      false,
      { cause: lastError },
    );
  }

  private async pollForResult(hash: string, opts: SubmitOptions): Promise<SubmitResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + pollTimeoutMs;

    for (;;) {
      const status = await this.sorobanService.getTransactionStatus(hash);
      if (status.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        return this.finalize(status, hash);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for confirmation of Soroban transaction ${hash}`);
      }
      await sleep(pollIntervalMs);
    }
  }

  private finalize(status: SorobanRpc.Api.GetTransactionResponse, hash: string): SubmitResult {
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanSubmissionError(`Soroban transaction failed on-chain (hash=${hash})`, hash, 1, true);
    }
    return { hash, status: status.status, response: status as SorobanRpc.Api.GetSuccessfulTransactionResponse };
  }
}
