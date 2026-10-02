import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverGriefingService } from "../solvers/solver-griefing.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";
import { logger } from "../common/logger";
import { MetricsService } from "../metrics/metrics.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { Intent } from "./intents.types";
import { DeadlineJobData, DEADLINE_QUEUE, EXPIRE_INTENT_JOB, FILL_WINDOW_EXPIRED_JOB } from "./intents-deadline.jobs";
import { JobsService } from "../jobs/jobs.service";
import {
  AppConfig,
  CHAIN_FILL_WINDOW_DEFAULTS,
  DEFAULT_FILL_WINDOW_SECONDS,
} from "../config/configuration";
import { LeaderElectionService, Singleton } from "../common/leader-election";
import { ConfigService } from "@nestjs/config";

/** Low-frequency safety scan. Deadline jobs are the primary expiry path (issue #437). */
const SAFETY_SWEEP_INTERVAL_MS = 300_000;

/** Outcome of a single sweep cycle — returned so a manual trigger can log it. */
export interface SweepResult {
  expiredCount: number;
  slashedCount: number;
  /** Intents whose fill window was pushed out because a pause blocked fills. */
  extendedDeadlines: number;
  durationMs: number;
}

@Singleton("sweeper")
@Injectable()
export class IntentsSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentsSweeperService.name);
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
    private readonly solversService: SolversService,
    @Optional() private readonly griefingService: SolverGriefingService | null,
    private readonly solverRegistryService: SolverRegistryService,
    private readonly metricsService: MetricsService,
    private readonly killSwitch: KillSwitchService,
    private readonly leaderElection: LeaderElectionService,
    @Optional() private readonly config?: ConfigService<AppConfig, true>,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  onModuleInit() {
    this.jobs?.defineQueue(DEADLINE_QUEUE, { concurrency: 8 });
    this.jobs?.process(EXPIRE_INTENT_JOB, (data) => this.handleExpireJob(data));
    this.jobs?.process(FILL_WINDOW_EXPIRED_JOB, (data) => this.handleFillWindowJob(data));
    this.leaderElection.registerWorker("sweeper", (isLeader, _token) => {
      if (isLeader) {
        this.logger.log("[sweeper] became leader — starting interval");
        this.startInterval();
      } else {
        this.logger.log("[sweeper] lost leadership — stopping interval");
        this.stopInterval();
      }
    });
  }

  onModuleDestroy() {
    this.stopInterval();
  }

  private startInterval(): void {
    if (this.interval) return; // already running
    this.interval = setInterval(() => {
      this.sweep({ safety: true }).catch((err) => {
        logger.error(`[sweeper] sweep failed: ${err instanceof Error ? err.message : err}`);
      });
    }, this.safetyIntervalMs());
  }

  private stopInterval(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  async sweep(options?: { safety?: boolean }): Promise<SweepResult> {
    const startMs = Date.now();
    const now = Math.floor(startMs / 1000);
    let expiredCount = 0;
    let slashedCount = 0;
    let extendedDeadlines = 0;

    for (const intent of await this.intentsService.getByState("open")) {
      if (intent.deadline <= now && (await this.expireOpen(intent, now))) expiredCount++;
    }

    const durationMs = Date.now() - startMs;

    // Record sweep metrics into the Prometheus-backed MetricsService (issue #259).
    // This replaces the retired MetricsRegistry from src/common/metrics.ts.
    this.metricsService.recordSweep(expiredCount, durationMs);

    this.logger.debug(`sweep complete: expired=${expiredCount} duration=${durationMs}ms`);

    if (expiredCount > 0) {
      this.logger.log(`[sweeper] Expired ${expiredCount} intent(s) in ${durationMs}ms`);
    }

    const missedFills = (await this.intentsService.getByState("accepted")).filter(
      (intent) => intent.deadline <= now,
    );

    for (const intent of missedFills) {
      // Issue #477 — an emergency pause must not punish solvers for a pause we
      // imposed. When the fill path is paused for this intent's scope, extend
      // its window instead of slashing; the intent becomes fillable again on
      // resume. Evaluated per intent because a pause may be scoped to a single
      // chain or token.
      const outcome = await this.settleAccepted(intent, now);
      if (outcome === "slashed") slashedCount++;
      if (outcome === "extended") extendedDeadlines++;
    }

    if (options?.safety) this.metricsService.recordSafetyCatch?.(expiredCount + slashedCount);

    return {
      expiredCount,
      slashedCount,
      extendedDeadlines,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Returns the new deadline to grant when fills are paused for this intent, or
   * null when slashing should proceed.
   *
   * Grants a full fill window from now rather than a fixed bump, so an intent
   * caught by a long pause still gets a fair window once the pause lifts.
   */
  private pausedFillDeadline(intent: Intent, now: number): number | null {
    const decision = this.killSwitch.evaluateTarget({
      chain: intent.srcChain,
      token: intent.srcToken?.address,
      operation: "fill",
    });
    if (!decision.paused) return null;

    const window = CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
    return now + window;
  }

  /**
   * `expire-intent` handler. No-ops when the intent is no longer open or the
   * stored deadline is not the one this job was armed for (amendment / stale job).
   */
  async handleExpireJob(data: DeadlineJobData): Promise<void> {
    const intent = await this.intentsService.get(data.intentId);
    if (!intent || intent.state !== "open" || intent.deadline !== data.deadline) return;
    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline > now) return;
    await this.expireOpen(intent, now);
  }

  /**
   * `fill-window-expired` handler. No-ops on a terminal state or a deadline
   * that has since been moved. A kill-switch pause extends the window instead
   * of slashing, and that extension arms a new job.
   */
  async handleFillWindowJob(data: DeadlineJobData): Promise<void> {
    const intent = await this.intentsService.get(data.intentId);
    if (!intent || intent.state !== "accepted" || intent.deadline !== data.deadline) return;
    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline > now) return;
    await this.settleAccepted(intent, now);
  }

  private safetyIntervalMs(): number {
    const configured = this.config?.get("safetySweepIntervalMs", { infer: true });
    return configured && configured > 0 ? configured : SAFETY_SWEEP_INTERVAL_MS;
  }

  private async expireOpen(intent: Intent, now: number): Promise<boolean> {
    const expired = await this.intentsService.expireIfOpen(intent.intentId);
    if (!expired) return false;
    this.intentsService.appendAuditEntry(
      intent.intentId,
      "expired",
      "system",
      "deadline passed",
      { deadline: intent.deadline, sweepedAt: now },
    );
    await this.intentsGateway.broadcast({ type: "intent_expired", intentId: intent.intentId });
    return true;
  }

  private async settleAccepted(intent: Intent, now: number): Promise<"slashed" | "extended" | "skipped"> {
    const deadline = this.pausedFillDeadline(intent, now);
    if (deadline !== null) {
      const extended = await this.intentsService.extendDeadlineIfAccepted(intent.intentId, deadline);
      if (!extended) return "skipped";
      this.logger.warn(
        `[sweeper] intent ${intent.intentId} fill is paused by a kill-switch — ` +
          `slashing suppressed and deadline extended to ${deadline}`,
      );
      return "extended";
    }
    const slashed = await this.slashMissedFill(intent.intentId, intent.solver, now);
    return slashed ? "slashed" : "skipped";
  }

  /**
   * Issue #269 — safe, auditable manual sweep trigger (operator break-glass).
   *
   * Runs exactly one sweep cycle on demand and logs the invocation loudly —
   * source, timestamp, and result — so a manual trigger is unmistakable in an
   * incident timeline. Wired to `SIGUSR2` in `main.ts`; there is deliberately
   * no HTTP surface, so it is not reachable by any API client.
   */
  async triggerManualSweep(source: string): Promise<SweepResult> {
    const invokedAt = new Date().toISOString();
    this.logger.warn(
      `[sweeper] MANUAL SWEEP TRIGGERED (source=${source}, invokedAt=${invokedAt}) — running one sweep cycle`,
    );

    try {
      const result = await this.sweep();
      this.logger.warn(
        `[sweeper] MANUAL SWEEP COMPLETE (source=${source}, invokedAt=${invokedAt}): ` +
          `expired=${result.expiredCount} slashed=${result.slashedCount} duration=${result.durationMs}ms`,
      );
      return result;
    } catch (err) {
      this.logger.error(
        `[sweeper] MANUAL SWEEP FAILED (source=${source}, invokedAt=${invokedAt}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  private async slashMissedFill(
    intentId: string,
    solver: string | undefined,
    now: number,
  ): Promise<boolean> {
    const reason = "accepted intent not filled before deadline";

    // Atomic guard: a concurrent solver fill() may have already transitioned
    // this intent out of "accepted" — skip slashing if so (fill wins).
    const slashed = await this.intentsService.slashIfAccepted(intentId, {
      slashedAt: now,
      slashReason: reason,
    });
    if (!slashed) return false;
    this.intentsService.appendAuditEntry(intentId, "slashed", "system", reason, {
      solver,
      slashedAt: now,
    });
    await this.intentsGateway.broadcast({ type: "intent_slashed", intentId, solver, reason });

    if (!solver) {
      // Shouldn't happen in practice — an "accepted" intent always has a
      // solver — but don't let a bad record throw the whole sweep cycle.
      logger.error(`[sweeper] intent ${intentId} was accepted with no solver on record`);
      return true;
    }

    await this.solversService.recordFailedFill(solver, intentId);
    const slashRecord = await this.solversService.recordSlash(solver, intentId, reason, now);

    // Anti-griefing: record the unfilled accept so the rolling ratio is updated
    // and enforcement can escalate if this is a repeated offence (issue #453).
    if (this.griefingService) {
      this.griefingService.recordUnfilled(solver, intentId, now);
    }

    const result = await this.solverRegistryService.slashSolver({
      solverAddress: solver,
      intentId,
      reason,
    });
    console.log(
      `[sweeper] slashed solver=${solver} for intent=${intentId}: ${result.detail} slashId=${slashRecord?.slashId ?? "unknown"}`,
    );
    return true;
  }
}
