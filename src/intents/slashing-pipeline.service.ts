import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { KillSwitchActiveException } from "../killswitch/killswitch.guard";
import { MetricsService } from "../metrics/metrics.service";
import { SolversService } from "../solvers/solvers.service";
import {
  IPendingSlashesRepository,
  PENDING_SLASHES_REPOSITORY,
  PendingSlash,
  PendingSlashState,
} from "../solvers/pending-slashes.repository";
import { FillVerifierService } from "../soroban/fill-verifier.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";
import { TxConfirmationService } from "../soroban/tx-confirmation.service";
import { IntentsGateway } from "./intents.gateway";
import { IntentsService } from "./intents.service";

const PROCESS_INTERVAL_MS = 15_000;
const PROCESS_BATCH_SIZE = 25;
/** Lease while one worker verifies/submits a slash; also blocks admin cancel mid-submit. */
const LEASE_SECONDS = 120;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** Re-check interval while a kill-switch pause blocks slashing. */
const PAUSED_RECHECK_MS = 60_000;
/** How long a submitted slash may stay unseen by RPC before it is treated as dropped. */
const SUBMIT_NOT_FOUND_GRACE_SECONDS = 120;

/** Why a slash was cancelled — also the `reason` label on the metric. */
export type SlashCancelReason =
  | "fill_landed"
  | "admin"
  | "solver_not_found"
  | "submit_failed";

/** Cancellable before broadcast only; after that the chain decides. */
const CANCELLABLE: PendingSlashState[] = ["detected", "challenge_window"];

export interface DetectMissedFillInput {
  intentId: string;
  solverAddress: string;
  reason: string;
  /** The accepted intent's fill deadline, unix seconds. */
  fillDeadline: number;
  /** Server time at detection, unix seconds. */
  detectedAt: number;
}

/**
 * Saga connecting sweeper detection to the on-chain slash (issue #397):
 *
 *   detected → challenge_window → submitted → confirmed | cancelled
 *
 * - **Durable + exactly-once**: one `pending_slashes` row per intent (unique
 *   constraint). Re-detection is a no-op; every step is a conditional state
 *   transition, so a crash anywhere resumes from the stored state.
 * - **Challenge window** (SLASH_CHALLENGE_WINDOW_SECONDS, default 10 min): the
 *   slash is not broadcast before it ends. During it a solver fill-proof or an
 *   admin cancels the slash.
 * - **Re-verification**: when the window ends the chain is checked again for a
 *   fill that landed by `fillDeadline + SLASH_CLOCK_SKEW_TOLERANCE_SECONDS`
 *   (ledger close time). If one landed, the slash is cancelled. If the check
 *   itself fails, the slash is retried later — never submitted blind.
 * - **Compensation**: the sweeper's optimistic `recordFailedFill` is reverted
 *   via `SolversService.rollbackPenalty` on every cancellation, and the intent
 *   leaves `slashed` (→ `filled` for a proven fill, → `expired` otherwise).
 *   Compensation runs only on the winning `→ cancelled` transition, so it
 *   happens at most once.
 */
@Injectable()
export class SlashingPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlashingPipelineService.name);
  private readonly settings: AppConfig["slashing"];
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(PENDING_SLASHES_REPOSITORY) private readonly slashes: IPendingSlashesRepository,
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
    private readonly solversService: SolversService,
    private readonly solverRegistry: SolverRegistryService,
    private readonly fillVerifier: FillVerifierService,
    private readonly confirmation: TxConfirmationService,
    private readonly metrics: MetricsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    this.settings = configService.get("slashing", { infer: true });
  }

  onModuleInit() {
    this.interval = setInterval(() => {
      this.processDue().catch((err) =>
        this.logger.error(`[slashing] processing failed: ${errorMessage(err)}`),
      );
    }, PROCESS_INTERVAL_MS);
    this.interval.unref?.();
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  /**
   * Records a missed fill and opens its challenge window. Idempotent per
   * intent: a second detection returns the existing slash unchanged.
   */
  async detect(input: DetectMissedFillInput): Promise<PendingSlash> {
    const detectedAt = new Date(input.detectedAt * 1000);
    const { slash, created } = await this.slashes.createIfAbsent({
      intentId: input.intentId,
      solverAddress: input.solverAddress,
      reason: input.reason,
      fillDeadline: input.fillDeadline,
      detectedAt,
      challengeEndsAt: new Date(detectedAt.getTime() + this.settings.challengeWindowSeconds * 1000),
    });
    if (!created) {
      this.logger.warn(`[slashing] intent=${input.intentId} already has a slash (state=${slash.state}); ignoring`);
      return slash;
    }
    this.metrics.recordSlashTransition("detected");
    return (await this.openChallengeWindow(slash)) ?? slash;
  }

  /** Runs one pass over every slash that needs action now. */
  async processDue(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.slashes.findDue(now, PROCESS_BATCH_SIZE);
      for (const slash of due) {
        const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
        if (!(await this.slashes.claim(slash.intentId, now, leaseUntil))) continue;
        try {
          await this.step(slash, now);
        } catch (err) {
          await this.retryOrGiveUp(slash, `unexpected error: ${errorMessage(err)}`, now);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Cancels a slash that has not been broadcast yet (admin action).
   * @throws NotFoundException / ConflictException when there is nothing to cancel.
   */
  async cancelByAdmin(intentId: string, actor: string, note: string): Promise<PendingSlash> {
    const slash = await this.slashes.findByIntent(intentId);
    if (!slash) throw new NotFoundException(`No slash recorded for intent ${intentId}`);
    const cancelled = await this.cancel(slash, "admin", actor, { note }, new Date());
    if (!cancelled) {
      throw new ConflictException(
        `Slash for intent ${intentId} cannot be cancelled (state=${slash.state}` +
          `${slash.lockedUntil ? ", submission in progress — retry shortly" : ""})`,
      );
    }
    return cancelled;
  }

  /**
   * Cancels a slash on a solver-supplied proof that its fill landed in time.
   * @throws when the slash is not cancellable, the solver is not the slashed
   *         one, or the proof does not verify on-chain.
   */
  async cancelByFillProof(intentId: string, solver: string, txHash: string): Promise<PendingSlash> {
    const slash = await this.slashes.findByIntent(intentId);
    if (!slash) throw new NotFoundException(`No slash recorded for intent ${intentId}`);
    if (slash.solverAddress !== solver) {
      throw new ForbiddenException("Only the slashed solver may submit a fill proof");
    }
    if (!CANCELLABLE.includes(slash.state)) {
      throw new ConflictException(`Slash for intent ${intentId} is ${slash.state}; the challenge window is over`);
    }

    const proof = await this.fillVerifier.verifyFillProof(txHash, intentId, this.latestAcceptable(slash));
    if (!proof.valid) throw new UnprocessableEntityException(`Fill proof rejected: ${proof.reason}`);

    const cancelled = await this.cancel(slash, "fill_landed", solver, { fillTxHash: txHash }, new Date());
    if (!cancelled) {
      throw new ConflictException(`Slash for intent ${intentId} changed state while verifying; retry`);
    }
    return cancelled;
  }

  getByIntent(intentId: string): Promise<PendingSlash | undefined> {
    return this.slashes.findByIntent(intentId);
  }

  list(state: PendingSlashState | undefined, limit: number): Promise<PendingSlash[]> {
    return this.slashes.list({ state, limit });
  }

  // ── saga steps ────────────────────────────────────────────────────────────

  private async step(slash: PendingSlash, now: Date): Promise<void> {
    switch (slash.state) {
      case "detected":
        await this.openChallengeWindow(slash);
        return;
      case "challenge_window":
        await this.verifyAndSubmit(slash, now);
        return;
      case "submitted":
        await this.confirm(slash, now);
        return;
      // confirmed / cancelled are terminal and never returned by findDue.
    }
  }

  private async openChallengeWindow(slash: PendingSlash): Promise<PendingSlash | null> {
    const opened = await this.slashes.transition(slash.intentId, ["detected"], { state: "challenge_window" });
    if (!opened) return null;
    this.metrics.recordSlashTransition("challenge_window");
    this.intentsService.appendAuditEntry(slash.intentId, "slashed", "system", "slash pending: challenge window open", {
      solver: slash.solverAddress,
      challengeEndsAt: opened.challengeEndsAt.toISOString(),
    });
    this.logger.log(
      `[slashing] intent=${slash.intentId} solver=${slash.solverAddress} challenge window open until ` +
        opened.challengeEndsAt.toISOString(),
    );
    return opened;
  }

  private async verifyAndSubmit(slash: PendingSlash, now: Date): Promise<void> {
    // 1. Re-verify: a fill that landed in time (late event, missed API call)
    //    must never be slashed. Failure to check is not evidence of absence.
    let fill;
    try {
      fill = await this.fillVerifier.findLandedFill(
        slash.intentId,
        slash.fillDeadline,
        this.latestAcceptable(slash),
        Math.floor(now.getTime() / 1000),
      );
    } catch (err) {
      await this.retryOrGiveUp(slash, `fill re-verification failed: ${errorMessage(err)}`, now);
      return;
    }
    if (fill) {
      await this.cancel(slash, "fill_landed", "system", { fillTxHash: fill.txHash }, undefined);
      return;
    }

    // 2. Solver deregistered mid-window: deregistration must not be an escape
    //    hatch, so the slash proceeds. A solver with no record at all cannot
    //    be penalised by the registry — cancel and compensate.
    const solver = await this.solversService.get(slash.solverAddress);
    if (!solver) {
      await this.cancel(slash, "solver_not_found", "system", {}, undefined);
      return;
    }
    if (!solver.isActive) {
      this.logger.warn(
        `[slashing] solver=${slash.solverAddress} deregistered during the challenge window; slashing intent=${slash.intentId} anyway`,
      );
    }

    // 3. Submit. The registry contract keys slashes by intent id, so a
    //    resubmission after a crash cannot double-slash on-chain.
    let result;
    try {
      result = await this.solverRegistry.slashSolver({
        solverAddress: slash.solverAddress,
        intentId: slash.intentId,
        reason: slash.reason,
      });
    } catch (err) {
      if (!(err instanceof KillSwitchActiveException)) throw err;
      // Issue #477 — a pause on `slash`/`onchain` defers the slash without
      // consuming an attempt, so a long pause can never make the saga give up.
      await this.slashes.transition(slash.intentId, ["challenge_window"], {
        nextAttemptAt: new Date(now.getTime() + PAUSED_RECHECK_MS),
        lastError: `paused by kill-switch: ${err.message}`,
      });
      return;
    }
    if (result.failed) {
      await this.retryOrGiveUp(slash, result.detail, now);
      return;
    }

    const submitted = await this.slashes.transition(slash.intentId, ["challenge_window"], {
      state: "submitted",
      txHash: result.txHash,
      simulated: !result.submitted,
      submittedAt: now,
      nextAttemptAt: now,
      lastError: undefined,
    });
    if (!submitted) return;
    this.metrics.recordSlashTransition("submitted", result.submitted ? "broadcast" : "simulated");
    this.intentsService.appendAuditEntry(slash.intentId, "slashed", "system", "slash submitted", {
      solver: slash.solverAddress,
      txHash: result.txHash,
      simulated: !result.submitted,
      solverActive: solver.isActive,
      detail: result.detail,
    });
    this.logger.log(
      `[slashing] intent=${slash.intentId} solver=${slash.solverAddress} submitted ` +
        `(${result.submitted ? `tx ${result.txHash}` : "simulated only"}): ${result.detail}`,
    );
  }

  private async confirm(slash: PendingSlash, now: Date): Promise<void> {
    if (!slash.txHash) {
      await this.slashes.transition(slash.intentId, ["submitted"], {});
      return;
    }
    let status;
    try {
      status = (await this.confirmation.check(slash.txHash)).status;
    } catch (err) {
      await this.slashes.transition(slash.intentId, ["submitted"], {
        nextAttemptAt: this.backoff(slash.attempts, now),
        lastError: `confirmation lookup failed: ${errorMessage(err)}`,
      });
      return;
    }

    if (status === "success") {
      const confirmed = await this.slashes.transition(slash.intentId, ["submitted"], {
        state: "confirmed",
        confirmedAt: now,
      });
      if (confirmed) {
        this.metrics.recordSlashTransition("confirmed");
        this.intentsService.appendAuditEntry(slash.intentId, "slashed", "system", "slash confirmed on-chain", {
          txHash: slash.txHash,
        });
      }
      return;
    }

    const age = slash.submittedAt ? now.getTime() - slash.submittedAt.getTime() : Infinity;
    if (status === "failed" || age > SUBMIT_NOT_FOUND_GRACE_SECONDS * 1000) {
      // Back into the window state so the next pass re-verifies and resubmits.
      const reopened = await this.slashes.transition(slash.intentId, ["submitted"], {
        state: "challenge_window",
        txHash: undefined,
      });
      if (reopened) {
        await this.retryOrGiveUp(reopened, `slash tx ${slash.txHash} ${status === "failed" ? "failed on-chain" : "not found"}`, now);
      }
      return;
    }

    await this.slashes.transition(slash.intentId, ["submitted"], {
      nextAttemptAt: new Date(now.getTime() + BASE_BACKOFF_MS),
    });
  }

  private async retryOrGiveUp(slash: PendingSlash, error: string, now: Date): Promise<void> {
    const attempts = slash.attempts + 1;
    if (attempts >= this.settings.maxSubmitAttempts) {
      this.logger.error(
        `[slashing] ALERT giving up on slash for intent=${slash.intentId} solver=${slash.solverAddress} ` +
          `after ${attempts} attempts: ${error}. Cancelling and compensating — see docs/runbooks/slash-cancellation.md`,
      );
      await this.cancel({ ...slash, attempts }, "submit_failed", "system", { lastError: error }, undefined);
      return;
    }
    await this.slashes.transition(slash.intentId, [slash.state], {
      attempts,
      nextAttemptAt: this.backoff(attempts, now),
      lastError: error,
    });
    this.logger.warn(
      `[slashing] intent=${slash.intentId} attempt ${attempts}/${this.settings.maxSubmitAttempts} failed: ${error}`,
    );
  }

  /**
   * Compensating transaction. Runs only if this call wins the `→ cancelled`
   * transition, so the rollback happens at most once per slash.
   *
   * @param now pass for externally-triggered cancels so an in-flight submission
   *            (active lease) is never cancelled underneath the worker.
   */
  private async cancel(
    slash: PendingSlash,
    reason: SlashCancelReason,
    actor: string,
    extra: { fillTxHash?: string; note?: string; lastError?: string },
    now: Date | undefined,
  ): Promise<PendingSlash | null> {
    const cancelled = await this.slashes.transition(
      slash.intentId,
      reason === "submit_failed" ? ["challenge_window", "submitted"] : CANCELLABLE,
      {
        state: "cancelled",
        cancelledAt: new Date(),
        cancelReason: extra.note ? `${reason}: ${extra.note}` : reason,
        cancelledBy: actor,
        fillTxHash: extra.fillTxHash,
        lastError: extra.lastError,
        attempts: slash.attempts,
      },
      now,
    );
    if (!cancelled) return null;

    await this.solversService.rollbackPenalty(slash.intentId, slash.solverAddress);

    const intent = await this.intentsService.get(slash.intentId);
    if (intent?.state === "slashed") {
      if (reason === "fill_landed") {
        await this.intentsService.update(slash.intentId, { state: "filled", txHash: extra.fillTxHash });
      } else {
        await this.intentsService.update(slash.intentId, { state: "expired" });
      }
    }
    const toState = reason === "fill_landed" ? "filled" : "expired";
    this.intentsService.appendAuditEntry(slash.intentId, toState, actor, `slash cancelled: ${reason}`, {
      solver: slash.solverAddress,
      fillTxHash: extra.fillTxHash,
      note: extra.note,
    });
    await this.intentsGateway.broadcast({
      type: "intent_slash_cancelled",
      intentId: slash.intentId,
      solver: slash.solverAddress,
      reason,
    });
    this.metrics.recordSlashTransition("cancelled", reason);
    this.logger.warn(
      `[slashing] slash for intent=${slash.intentId} solver=${slash.solverAddress} cancelled by ${actor}: ${reason}`,
    );
    return cancelled;
  }

  private latestAcceptable(slash: PendingSlash): number {
    return slash.fillDeadline + this.settings.clockSkewToleranceSeconds;
  }

  private backoff(attempts: number, now: Date): Date {
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
    return new Date(now.getTime() + delay);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
