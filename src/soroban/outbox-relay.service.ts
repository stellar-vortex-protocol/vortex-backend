import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { KillSwitchActiveException } from "../killswitch/killswitch.guard";
import { MetricsService } from "../metrics/metrics.service";
import { IOutboxRepository, OUTBOX_REPOSITORY, OutboxEntry } from "./outbox.repository";
import { buildOutboxInvocation } from "./outbox-operations";
import { StellarTxService } from "./stellar-tx.service";
import { TxConfirmationService } from "./tx-confirmation.service";

/** Upper bound for the exponential retry backoff. */
const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 1_000;

/** Re-check interval for rows blocked by a kill-switch pause. */
const PAUSED_RECHECK_MS = 30_000;

/** Counts from one relay tick — returned for tests and manual triggers. */
export interface RelayTickResult {
  claimed: number;
  /** Rows put back untouched because a kill-switch pause blocked the write. */
  paused: number;
  submitted: number;
  simulated: number;
  confirmed: number;
  retried: number;
  dead: number;
}

/**
 * Relay worker for the transactional outbox (issue #396).
 *
 * Each tick:
 *  1. **Confirm** — polls `submitted` rows through TxConfirmationService and
 *     marks them `confirmed`, or schedules a rebuild when the transaction
 *     failed on-chain or expired unseen.
 *  2. **Relay** — claims due head-of-intent rows (SKIP LOCKED in Postgres, so
 *     several instances can run this safely) and submits them via
 *     StellarTxService.
 *
 * StellarTxService.invokeContract blocks until the transaction confirms (or
 * throws on FAILED / confirmation TIMEOUT). A TIMEOUT retry is safe: the wait
 * (120 s) outlasts the envelope's 30 s time bound, so the timed-out envelope
 * can no longer land.
 *
 * Crash idempotency: the signed envelope's hash is persisted *before*
 * broadcast (`beforeSubmit`). If the process dies between broadcast and
 * `markSubmitted`, the lease expires, the row is reclaimed with its
 * `envelopeHash` set, and the relay looks that hash up first — SUCCESS means
 * the earlier submission landed and the row is confirmed without
 * resubmitting. NOT_FOUND is only trusted because the lease
 * (OUTBOX_LEASE_SECONDS) is longer than the envelope's time bound, so by
 * reclaim time an unseen envelope can no longer be included.
 *
 * Poison rows: after OUTBOX_MAX_ATTEMPTS claims a row moves to `dead`,
 * increments `vortex_outbox_dead_total` (alerted on) and blocks later rows
 * for the same intent until an operator requeues it — see
 * docs/runbooks/on-call.md.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly settings: AppConfig["outbox"];
  private readonly settlementContractId: string;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: IOutboxRepository,
    private readonly stellarTxService: StellarTxService,
    private readonly confirmation: TxConfirmationService,
    private readonly metrics: MetricsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.settings = configService.get("outbox", { infer: true });
    this.settlementContractId = configService.get("stellar.settlementContractId", { infer: true });
  }

  onModuleInit() {
    if (!this.settings.relayEnabled) {
      this.logger.warn("[outbox] relay disabled (OUTBOX_RELAY_ENABLED=false) — rows will accumulate");
      return;
    }
    this.interval = setInterval(() => {
      this.tick().catch((err) =>
        this.logger.error(`[outbox] relay tick failed: ${errorMessage(err)}`),
      );
    }, this.settings.relayIntervalMs);
    this.interval.unref?.();
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  /** Runs one confirm + relay cycle. Overlapping calls are skipped. */
  async tick(now: Date = new Date()): Promise<RelayTickResult> {
    const result: RelayTickResult = {
      claimed: 0,
      paused: 0,
      submitted: 0,
      simulated: 0,
      confirmed: 0,
      retried: 0,
      dead: 0,
    };
    if (this.running) return result;
    this.running = true;
    try {
      await this.confirmSubmitted(now, result);
      await this.relayDue(now, result);
      await this.refreshBacklogGauge();
      return result;
    } finally {
      this.running = false;
    }
  }

  private async confirmSubmitted(now: Date, result: RelayTickResult): Promise<void> {
    const submitted = await this.outbox.findSubmitted(this.settings.batchSize);
    for (const entry of submitted) {
      if (!entry.txHash) continue;
      let status;
      try {
        status = (await this.confirmation.check(entry.txHash)).status;
      } catch (err) {
        // RPC outage is not evidence either way — look again next tick.
        this.logger.warn(`[outbox] confirmation lookup failed for row ${entry.id}: ${errorMessage(err)}`);
        continue;
      }

      if (status === "success") {
        if (await this.outbox.markConfirmed(entry, entry.txHash)) {
          result.confirmed++;
          this.metrics.recordOutboxOutcome("confirmed");
        }
      } else if (status === "failed") {
        await this.fail(entry, `transaction ${entry.txHash} failed on-chain`, now, result);
      } else if (now.getTime() - entry.updatedAt.getTime() > this.settings.leaseSeconds * 1000) {
        await this.fail(entry, `transaction ${entry.txHash} not found after lease; rebuilding`, now, result);
      }
    }
  }

  private async relayDue(now: Date, result: RelayTickResult): Promise<void> {
    const leaseUntil = new Date(now.getTime() + this.settings.leaseSeconds * 1000);
    const claimed = await this.outbox.claimDue(now, this.settings.batchSize, leaseUntil);
    result.claimed += claimed.length;
    // Sequential on purpose: every submission draws the next sequence number
    // from the single signing account (SignerService serializes anyway).
    for (const entry of claimed) {
      await this.process(entry, now, result);
    }
  }

  private async process(entry: OutboxEntry, now: Date, result: RelayTickResult): Promise<void> {
    try {
      if (entry.envelopeHash) {
        const previous = await this.confirmation.check(entry.envelopeHash);
        if (previous.status === "success") {
          this.logger.warn(
            `[outbox] row ${entry.id} (${entry.operation} intent=${entry.intentId}) was already ` +
              `submitted before a crash (tx ${entry.envelopeHash}); confirming without resubmitting`,
          );
          if (await this.outbox.markConfirmed(entry, entry.envelopeHash)) {
            result.confirmed++;
            this.metrics.recordOutboxOutcome("confirmed");
          }
          return;
        }
        if (previous.status === "failed") {
          throw new Error(`previous envelope ${entry.envelopeHash} failed on-chain`);
        }
        // not_found: the lease outlived the envelope's time bound — rebuild.
      }

      if (!this.settlementContractId) {
        throw new Error("SETTLEMENT_CONTRACT_ID is not configured");
      }
      const invocation = buildOutboxInvocation(entry, this.settlementContractId);
      const sent = await this.stellarTxService.invokeContract(invocation, {
        beforeSubmit: async (hash) => {
          if (!(await this.outbox.recordEnvelope(entry, hash))) {
            throw new Error(`lost lease on row ${entry.id} before submit`);
          }
        },
      });

      if (sent.dryRun) {
        if (await this.outbox.markSimulated(entry)) {
          result.simulated++;
          this.metrics.recordOutboxOutcome("simulated");
        }
        return;
      }

      // StellarTxService's live path waits for confirmation and reports
      // SUCCESS; anything else (e.g. PENDING) is confirmed by a later tick.
      if (sent.status === "SUCCESS") {
        if (await this.outbox.markConfirmed(entry, sent.hash)) {
          result.submitted++;
          result.confirmed++;
          this.metrics.recordOutboxOutcome("confirmed");
        }
        return;
      }
      if (await this.outbox.markSubmitted(entry, sent.hash)) {
        result.submitted++;
        this.metrics.recordOutboxOutcome("submitted");
      }
    } catch (err) {
      if (err instanceof KillSwitchActiveException) {
        // Issue #477 — a pause is not a failure: put the row back without
        // consuming an attempt so a long pause cannot dead-letter it.
        if (await this.outbox.release(entry, `paused by kill-switch: ${err.message}`, new Date(now.getTime() + PAUSED_RECHECK_MS))) {
          result.paused++;
        }
        return;
      }
      await this.fail(entry, errorMessage(err), now, result);
    }
  }

  private async fail(
    entry: OutboxEntry,
    error: string,
    now: Date,
    result: RelayTickResult,
  ): Promise<void> {
    if (entry.attempts >= this.settings.maxAttempts) {
      if (await this.outbox.markDead(entry, error)) {
        result.dead++;
        this.metrics.recordOutboxOutcome("dead");
        this.logger.error(
          `[outbox] ALERT row ${entry.id} (${entry.operation} intent=${entry.intentId}) moved to dead ` +
            `after ${entry.attempts} attempts: ${error}. Later operations for this intent are blocked ` +
            `until it is requeued — see docs/runbooks/on-call.md`,
        );
      }
      return;
    }

    const delay = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, entry.attempts - 1), MAX_BACKOFF_MS);
    if (await this.outbox.scheduleRetry(entry, error, new Date(now.getTime() + delay))) {
      result.retried++;
      this.metrics.recordOutboxOutcome("retry");
      this.logger.warn(
        `[outbox] row ${entry.id} (${entry.operation} intent=${entry.intentId}) attempt ` +
          `${entry.attempts}/${this.settings.maxAttempts} failed: ${error}; retrying in ${delay}ms`,
      );
    }
  }

  private async refreshBacklogGauge(): Promise<void> {
    try {
      this.metrics.setOutboxBacklog(await this.outbox.countByStatus());
    } catch (err) {
      this.logger.warn(`[outbox] backlog gauge refresh failed: ${errorMessage(err)}`);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
