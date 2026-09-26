import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Keypair, SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { PrismaService } from "../prisma/prisma.service";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";
import { SignerService } from "./signer.service";
import { FeeEscalationPolicy } from "./fee-escalation-policy";
import { TxConfirmed, TxFailed, TxExpired } from "./tx-events";

export interface TrackTxOptions {
  txHash: string;
  txXdr: string;
  intentId?: string;
  channelKey?: string;
  /** Unix epoch seconds after which tracking is abandoned. */
  maxTrackUntil: number;
}

// Polling constants
const POLL_INTERVAL_MS = 5_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const JITTER_FACTOR = 0.3; // ±30% jitter

function backoffMs(attempt: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = exp * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(exp + jitter);
}

type PollRow = {
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
};

@Injectable()
export class TxConfirmationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TxConfirmationService.name);
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly signer: SignerService,
    private readonly feePolicy: FeeEscalationPolicy,
    private readonly metrics: MetricsService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.pollBatch()
        .catch((err) =>
          this.logger.error(
            `poll batch failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => {
          this.running = false;
        });
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  /** Enqueue a submitted transaction for tracking. */
  async track(opts: TrackTxOptions): Promise<void> {
    await this.prisma.pendingTransaction.upsert({
      where: { txHash: opts.txHash },
      create: {
        txHash: opts.txHash,
        txXdr: opts.txXdr,
        intentId: opts.intentId ?? null,
        channelKey: opts.channelKey ?? null,
        status: "pending",
        maxTrackUntil: opts.maxTrackUntil,
        nextPollAt: Math.floor(Date.now() / 1000) + 2,
        lastFeeStroops: null,
        feeBumpCount: 0,
      },
      update: {},
    });
    this.logger.log(
      `Tracking tx ${opts.txHash} until ${new Date(opts.maxTrackUntil * 1000).toISOString()}`,
    );
  }

  private async pollBatch(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // Claim up to 50 pending transactions due for polling.
    // SELECT ... FOR UPDATE SKIP LOCKED prevents double-processing under multiple replicas.
    const claimed = await this.prisma.$queryRaw<PollRow[]>`
      SELECT id, tx_hash, tx_xdr, intent_id, channel_key, status, max_track_until,
             attempts, next_poll_at, last_fee_stroops, fee_bump_count, created_at
      FROM   pending_transactions
      WHERE  status = 'pending'
        AND  next_poll_at <= ${now}
      ORDER  BY next_poll_at ASC
      LIMIT  50
      FOR    UPDATE SKIP LOCKED
    `;

    await Promise.all(claimed.map((row) => this.processRow(row)));
  }

  private async processRow(row: PollRow): Promise<void> {
    const startMs = Date.now();
    const now = Math.floor(startMs / 1000);

    // Check expiry first
    if (now > row.max_track_until) {
      await this.finalise(row.id, "expired", row.tx_hash, row.intent_id, startMs);
      return;
    }

    let result: SorobanRpc.Api.GetTransactionResponse;
    try {
      result = await this.soroban.getTransaction(row.tx_hash);
    } catch (err) {
      this.logger.warn(
        `getTransaction RPC error for ${row.tx_hash}: ${(err as Error).message}`,
      );
      await this.scheduleRetry(row.id, row.attempts + 1, row.max_track_until);
      return;
    }

    const status = result.status;

    if (status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      await this.finalise(
        row.id,
        "confirmed",
        row.tx_hash,
        row.intent_id,
        startMs,
        (result as SorobanRpc.Api.GetSuccessfulTransactionResponse).ledger,
      );
      return;
    }

    if (status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      const shouldBump = this.feePolicy.shouldEscalate({
        errorResultCode: "tx_insufficient_fee",
        feeBumpCount: row.fee_bump_count,
        maxTrackUntil: row.max_track_until,
        currentFeeStroops: row.last_fee_stroops ?? "100",
      });

      if (shouldBump && this.signer.isConfigured()) {
        await this.attemptFeeBump(row, startMs);
        return;
      }

      await this.finalise(row.id, "failed", row.tx_hash, row.intent_id, startMs);
      return;
    }

    if (status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      const newAttempts = row.attempts + 1;
      const delay = backoffMs(newAttempts);
      const nextPollAt = now + Math.round(delay / 1000);

      // Check fee-bump near expiry
      const shouldBump = this.feePolicy.shouldEscalate({
        feeBumpCount: row.fee_bump_count,
        maxTrackUntil: row.max_track_until,
        currentFeeStroops: row.last_fee_stroops ?? "100",
      });
      if (shouldBump && this.signer.isConfigured()) {
        await this.attemptFeeBump(row, startMs);
        return;
      }

      await this.prisma.pendingTransaction.update({
        where: { id: row.id },
        data: { attempts: newAttempts, nextPollAt },
      });
      return;
    }

    // Default: schedule retry
    await this.scheduleRetry(row.id, row.attempts + 1, row.max_track_until);
  }

  private async attemptFeeBump(row: PollRow, startMs: number): Promise<void> {
    const secret = this.signer.getSecretKey();
    if (!secret) {
      await this.finalise(row.id, "failed", row.tx_hash, row.intent_id, startMs);
      return;
    }
    const keypair = Keypair.fromSecret(secret);

    const bumped = await this.feePolicy.buildFeeBump({
      innerTxXdr: row.tx_xdr,
      feeSourceKeypair: keypair,
      networkPassphrase: this.signer.getNetworkPassphrase(),
      feeBumpCount: row.fee_bump_count,
    });

    if (!bumped) {
      // Ceiling hit — mark failed
      await this.finalise(row.id, "failed", row.tx_hash, row.intent_id, startMs);
      return;
    }

    try {
      const innerTx = new Transaction(row.tx_xdr, this.signer.getNetworkPassphrase());
      const sendResult = await this.soroban.submitTransaction(innerTx);
      this.logger.log(
        `Fee-bump submitted for ${row.tx_hash}, new status: ${sendResult.status}`,
      );
    } catch (err) {
      this.logger.warn(
        `Fee-bump submission failed for ${row.tx_hash}: ${(err as Error).message}`,
      );
    }

    // Update tracking record with new bump info
    const newAttempts = row.attempts + 1;
    await this.prisma.pendingTransaction.update({
      where: { id: row.id },
      data: {
        feeBumpCount: row.fee_bump_count + 1,
        txXdr: bumped.feeBumpXdr,
        lastFeeStroops: bumped.newFeeStroops,
        attempts: newAttempts,
        nextPollAt:
          Math.floor(Date.now() / 1000) + Math.round(backoffMs(newAttempts) / 1000),
      },
    });
  }

  private async finalise(
    id: bigint,
    outcome: "confirmed" | "failed" | "expired",
    txHash: string,
    intentId: string | null,
    startMs: number,
    ledger?: number,
  ): Promise<void> {
    await this.prisma.pendingTransaction.update({
      where: { id },
      data: { status: outcome },
    });

    const latencyMs = Date.now() - startMs;
    this.metrics.txConfirmationOutcomes.inc({ status: outcome });
    this.metrics.txConfirmationLatency.observe(latencyMs / 1000);

    if (outcome === "confirmed") {
      this.events.emit(
        TxConfirmed.EVENT,
        new TxConfirmed(txHash, intentId, ledger ?? 0, latencyMs),
      );
    } else if (outcome === "failed") {
      this.events.emit(
        TxFailed.EVENT,
        new TxFailed(txHash, intentId, "tx_failed", latencyMs),
      );
    } else {
      this.events.emit(TxExpired.EVENT, new TxExpired(txHash, intentId, latencyMs));
    }

    this.logger.log(`Tx ${txHash} finalised as ${outcome} (latency: ${latencyMs}ms)`);
  }

  private async scheduleRetry(
    id: bigint,
    attempts: number,
    maxTrackUntil: number,
  ): Promise<void> {
    const delay = backoffMs(attempts);
    const nextPollAt = Math.floor(Date.now() / 1000) + Math.round(delay / 1000);
    await this.prisma.pendingTransaction.update({
      where: { id },
      data: { attempts, nextPollAt },
    });
  }
}
