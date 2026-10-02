/**
 * TxConfirmationService (issues #386, #394)
 * ───────────────────────────────────────────
 * Two confirmation styles over the same pending-transaction ledger:
 *
 *  1. `check()` / `waitForConfirmation()` — direct lookups used by callers
 *     that hold the hash in memory (the outbox relay, the slashing saga, and
 *     StellarTxService's live submit path).
 *  2. `track()` + the poll batch — durable tracking for submissions whose
 *     outcome must survive a process restart: every tracked envelope lands in
 *     `pending_transactions`, and a background batch re-polls due rows until
 *     they confirm, fail (fee-bump recovery permitting), or age out past
 *     `maxTrackUntil`.
 *
 * Metrics: `vortex_tx_confirmation_outcomes_total` counts terminal outcomes
 * and `vortex_tx_confirmation_duration_seconds` records confirmation latency
 * (SLO SLI from issue #480).
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { FeeBumpTransaction, SorobanRpc } from "@stellar/stellar-sdk";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { FeeEscalationPolicy } from "./fee-escalation-policy";
import { TxConfirmed, TxExpired, TxFailed } from "./tx-events";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

/** How often the durable poll batch wakes up (issue #386). */
const POLL_BATCH_INTERVAL_MS = 5_000;
/** Maximum due rows claimed per poll batch. */
const POLL_BATCH_SIZE = 50;
/** Base delay before re-polling a NOT_FOUND row; doubles per attempt. */
const RETRY_BASE_DELAY_S = 5;
/** Cap on the exponential NOT_FOUND backoff. */
const RETRY_MAX_DELAY_S = 300;

/**
 * Normalized outcome of a single, non-blocking lookup ({@link TxConfirmationService.check}).
 *
 *   success   — applied successfully in a closed ledger.
 *   failed    — included in a ledger but the invocation failed.
 *   not_found — unknown to the RPC node: still pending, dropped, or expired
 *               past its time bound. Callers decide which using their own
 *               notion of elapsed time.
 */
export type TxConfirmationStatus = "success" | "failed" | "not_found";

/** Result of {@link TxConfirmationService.check} (issues #396 / #397). */
export interface TxConfirmation {
  status: TxConfirmationStatus;
  /** Ledger the transaction was included in (success/failed only). */
  ledger?: number;
  /** Ledger close time, unix seconds (success/failed only). */
  ledgerCloseTime?: number;
}

/** Blocking-poll outcome used by the live submit path (issue #394). */
export interface ConfirmationResult {
  hash: string;
  status: "SUCCESS" | "FAILED" | "TIMEOUT";
  /** Full RPC response when status is SUCCESS or FAILED. */
  response?: SorobanRpc.Api.GetTransactionResponse;
  /** Error message when status is FAILED or TIMEOUT. */
  error?: string;
  /** Wall-clock milliseconds from first poll until terminal status. */
  durationMs: number;
}

/** Options for {@link TxConfirmationService.track} (issue #386). */
export interface TrackTxOptions {
  /** Transaction hash returned by `sendTransaction`. */
  txHash: string;
  /** Base64 signed envelope, kept for fee-bump resubmission. */
  txXdr: string;
  /** Intent this submission belongs to, when it has one. */
  intentId?: string;
  /** Channel account used for submission, when a channel key signed it. */
  channelKey?: string;
  /** Unix seconds after which tracking is abandoned and the row expires. */
  maxTrackUntil: number;
}

/** One `pending_transactions` row as returned by the poll batch query. */
interface PendingTxRow {
  id: bigint;
  tx_hash: string;
  tx_xdr: string;
  intent_id: string | null;
  channel_key: string | null;
  status: string;
  max_track_until: number;
  attempts: number;
  next_poll_at: number;
  last_fee_stroops: string | null;
  fee_bump_count: number;
  created_at: Date;
}

@Injectable()
export class TxConfirmationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TxConfirmationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sorobanService: SorobanService,
    private readonly signerService: SignerService,
    private readonly feePolicy: FeeEscalationPolicy,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  // ── Durable tracking (issue #386) ─────────────────────────────────────────

  /**
   * Persist a submission for durable tracking. Idempotent per hash: a
   * re-track resets the row to `pending` with a fresh time bound so a
   * resumed workflow picks the envelope up again after a restart.
   */
  async track(opts: TrackTxOptions): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.prisma.pendingTransaction.upsert({
      where: { txHash: opts.txHash },
      create: {
        txHash: opts.txHash,
        txXdr: opts.txXdr,
        intentId: opts.intentId ?? null,
        channelKey: opts.channelKey ?? null,
        status: "pending",
        maxTrackUntil: opts.maxTrackUntil,
        attempts: 0,
        nextPollAt: now,
      },
      update: {
        txXdr: opts.txXdr,
        intentId: opts.intentId ?? null,
        channelKey: opts.channelKey ?? null,
        status: "pending",
        maxTrackUntil: opts.maxTrackUntil,
        attempts: 0,
        nextPollAt: now,
      },
    });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.pollBatch().catch((err: unknown) => {
        this.logger.warn(`[tx-confirmation] poll batch failed: ${(err as Error).message}`);
      });
    }, POLL_BATCH_INTERVAL_MS);
    // Never hold the process open just to poll.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Claim due pending rows and drive each toward a terminal state. One row's
   * RPC failure never aborts the batch — the row stays pending and is
   * re-polled on the next wake-up.
   */
  private async pollBatch(): Promise<void> {
    const rows = await this.prisma.$queryRaw<PendingTxRow[]>`
      SELECT id, tx_hash, tx_xdr, intent_id, channel_key, status, max_track_until,
             attempts, next_poll_at, last_fee_stroops, fee_bump_count, created_at
      FROM pending_transactions
      WHERE status = 'pending'
        AND next_poll_at <= EXTRACT(EPOCH FROM NOW())::bigint
      ORDER BY id
      LIMIT ${POLL_BATCH_SIZE}
    `;
    for (const row of rows) {
      try {
        await this.processRow(row);
      } catch (err) {
        this.logger.warn(
          `[tx-confirmation] poll failed for ${row.tx_hash}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Drive one pending row to a terminal state, a retry, or a fee bump. */
  private async processRow(row: PendingTxRow): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const latencyMs =
      row.created_at instanceof Date ? Math.max(0, Date.now() - row.created_at.getTime()) : 0;

    // Time bound first: an expired row must not burn an RPC round-trip, and
    // its terminal outcome is decided locally.
    if (row.max_track_until <= now) {
      await this.prisma.pendingTransaction.update({
        where: { id: row.id },
        data: { status: "expired" },
      });
      this.events?.emit(TxExpired.EVENT, new TxExpired(row.tx_hash, row.intent_id, latencyMs));
      this.metricsService?.txConfirmationOutcomes.inc({ status: "expired" });
      this.logger.warn(`[tx-confirmation] tracking expired hash=${row.tx_hash}`);
      return;
    }

    const response = await this.sorobanService.getTransaction(row.tx_hash);

    if (response.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      await this.prisma.pendingTransaction.update({
        where: { id: row.id },
        data: { status: "confirmed" },
      });
      this.events?.emit(
        TxConfirmed.EVENT,
        new TxConfirmed(row.tx_hash, row.intent_id, response.ledger, latencyMs),
      );
      this.metricsService?.txConfirmationOutcomes.inc({ status: "confirmed" });
      this.logger.log(`[tx-confirmation] confirmed hash=${row.tx_hash} ledger=${response.ledger}`);
      return;
    }

    if (response.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      if (await this.maybeFeeBump(row)) return;
      await this.prisma.pendingTransaction.update({
        where: { id: row.id },
        data: { status: "failed" },
      });
      let errorCode = "tx_failed";
      try {
        errorCode = response.resultXdr.result().switch().name || errorCode;
      } catch {
        /* decoded detail is best-effort; the terminal state is what matters */
      }
      this.events?.emit(TxFailed.EVENT, new TxFailed(row.tx_hash, row.intent_id, errorCode, latencyMs));
      this.metricsService?.txConfirmationOutcomes.inc({ status: "failed" });
      this.logger.warn(`[tx-confirmation] failed hash=${row.tx_hash} code=${errorCode}`);
      return;
    }

    // NOT_FOUND: still pending or dropped — escalate when the policy says the
    // time bound is close, otherwise retry with capped exponential backoff.
    if (await this.maybeFeeBump(row)) return;
    const delayS = Math.min(RETRY_BASE_DELAY_S * 2 ** Math.min(row.attempts, 8), RETRY_MAX_DELAY_S);
    await this.prisma.pendingTransaction.update({
      where: { id: row.id },
      data: { attempts: row.attempts + 1, nextPollAt: now + delayS },
    });
  }

  /**
   * Apply the fee-escalation ladder when the policy asks for it.
   *
   * Returns true when a bumped envelope was built and submitted (the row
   * follows the new hash and stays pending), false when escalation is not
   * warranted or not possible — remote signer backends never expose key
   * material, so they deliberately fall through to the terminal path.
   */
  private async maybeFeeBump(row: PendingTxRow): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (
      !this.feePolicy.shouldEscalate({
        feeBumpCount: row.fee_bump_count,
        maxTrackUntil: row.max_track_until,
        currentFeeStroops: row.last_fee_stroops ?? "0",
      })
    ) {
      return false;
    }
    if (!this.signerService.isConfigured()) return false;
    const feeSource = this.signerService.getFeeSourceKeypair();
    if (!feeSource) return false;

    const networkPassphrase = this.signerService.getNetworkPassphrase();
    const bump = await this.feePolicy.buildFeeBump({
      innerTxXdr: row.tx_xdr,
      feeSourceKeypair: feeSource,
      networkPassphrase,
      feeBumpCount: row.fee_bump_count,
    });
    if (!bump) return false;

    const envelope = new FeeBumpTransaction(bump.feeBumpXdr, networkPassphrase);
    const sent = await this.sorobanService.submitTransaction(envelope);
    if (sent.status === "ERROR") {
      this.logger.warn(`[tx-confirmation] fee-bump submit rejected for ${row.tx_hash}`);
      return false;
    }

    const bumpedHash = envelope.hash().toString("hex").toUpperCase();
    await this.prisma.pendingTransaction.update({
      where: { id: row.id },
      data: {
        txHash: bumpedHash,
        feeBumpCount: row.fee_bump_count + 1,
        lastFeeStroops: bump.newFeeStroops,
        attempts: row.attempts + 1,
        nextPollAt: now + RETRY_BASE_DELAY_S,
      },
    });
    this.logger.log(
      `[tx-confirmation] fee-bumped ${row.tx_hash} -> ${bumpedHash} (bump #${row.fee_bump_count + 1})`,
    );
    return true;
  }

  // ── Direct lookups ────────────────────────────────────────────────────────

  /**
   * Single, non-blocking lookup of `hash` (issues #396 / #397).
   *
   * For durable callers — the outbox relay and the slashing saga — that
   * persist the hashes they wait on and re-check on their own schedule, so a
   * restart never loses an in-flight transaction and a worker tick never
   * blocks for the full {@link waitForConfirmation} timeout. RPC transport
   * errors propagate so callers can retry rather than mistake an outage for
   * NOT_FOUND.
   */
  async check(hash: string): Promise<TxConfirmation> {
    const response = await this.sorobanService.getTransaction(hash);
    switch (response.status) {
      case SorobanRpc.Api.GetTransactionStatus.SUCCESS:
        return { status: "success", ledger: response.ledger, ledgerCloseTime: response.createdAt };
      case SorobanRpc.Api.GetTransactionStatus.FAILED:
        this.logger.warn(`[tx-confirmation] tx ${hash} failed in ledger ${response.ledger}`);
        return { status: "failed", ledger: response.ledger, ledgerCloseTime: response.createdAt };
      default:
        return { status: "not_found" };
    }
  }

  /**
   * Poll until the transaction identified by `hash` reaches a terminal state.
   *
   * @param hash         Transaction hash returned by `sendTransaction`.
   * @param submittedAt  Unix-ms timestamp when the transaction was submitted
   *                     (used to compute confirmation latency for the SLO SLI).
   * @param pollIntervalMs  How often to poll (default 3 s).
   * @param timeoutMs       Give-up threshold (default 2 min).
   */
  async waitForConfirmation(
    hash: string,
    submittedAt: number,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ConfirmationResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let response: SorobanRpc.Api.GetTransactionResponse;
      try {
        response = await this.sorobanService.getTransaction(hash);
      } catch (err) {
        this.logger.warn(
          `[tx-confirmation] getTransaction(${hash}) threw: ${(err as Error).message}; retrying`,
        );
        await sleep(pollIntervalMs);
        continue;
      }

      if (response.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        await sleep(pollIntervalMs);
        continue;
      }

      const durationMs = Date.now() - submittedAt;

      if (response.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        this.logger.log(
          `[tx-confirmation] SUCCESS hash=${hash} durationMs=${durationMs}`,
        );
        try {
          this.metricsService?.observeTxConfirmation(durationMs / 1000);
        } catch {
          /* metrics must never throw */
        }
        return { hash, status: "SUCCESS", response, durationMs };
      }

      // FAILED: extract the result-code name when the decoded result is present.
      let errorDetail = "unknown";
      try {
        errorDetail =
          (response as { resultXdr?: { result(): { switch(): { name: string } } } }).resultXdr
            ?.result()
            .switch().name ?? errorDetail;
      } catch {
        /* keep the generic detail */
      }
      this.logger.warn(
        `[tx-confirmation] FAILED hash=${hash} durationMs=${durationMs} detail=${errorDetail}`,
      );
      return { hash, status: "FAILED", response, error: errorDetail, durationMs };
    }

    const durationMs = Date.now() - submittedAt;
    this.logger.warn(
      `[tx-confirmation] TIMEOUT hash=${hash} after ${durationMs}ms`,
    );
    return {
      hash,
      status: "TIMEOUT",
      error: `Transaction not confirmed within ${timeoutMs}ms`,
      durationMs,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
