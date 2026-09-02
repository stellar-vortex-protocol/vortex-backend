import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";

const SWEEP_INTERVAL_MS = 30_000;

/** Outcome of a single sweep cycle — returned so a manual trigger can log it. */
export interface SweepResult {
  expiredCount: number;
  slashedCount: number;
  durationMs: number;
}

@Injectable()
export class IntentsSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentsSweeperService.name);
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly intentsService: IntentsService,
    private readonly intentsGateway: IntentsGateway,
    private readonly solversService: SolversService,
    private readonly solverRegistryService: SolverRegistryService,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      this.sweep().catch((err) => {
        console.error(`[sweeper] sweep failed: ${err instanceof Error ? err.message : err}`);
      });
    }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
  }

  async sweep(): Promise<SweepResult> {
    const startMs = Date.now();
    const now = Math.floor(startMs / 1000);
    let expiredCount = 0;
    let slashedCount = 0;

    for (const intent of await this.intentsService.getByState("open")) {
      if (intent.deadline <= now) {
        await this.intentsService.update(intent.intentId, { state: "expired" });
        // Audit trail (issue #62): system-driven expiration.
        this.intentsService.appendAuditEntry(
          intent.intentId,
          "expired",
          "system",
          "deadline passed",
          { deadline: intent.deadline, sweepedAt: now },
        );
        expiredCount++;
        this.intentsGateway.broadcast({ type: "intent_expired", intentId: intent.intentId });
      }
    }

    const durationMs = Date.now() - startMs;

    this.logger.debug(`sweep complete: expired=${expiredCount} duration=${durationMs}ms`);

    if (expiredCount > 0) {
      this.logger.log(`[sweeper] Expired ${expiredCount} intent(s) in ${durationMs}ms`);
    }

    const missedFills = (await this.intentsService.getByState("accepted")).filter(
      (intent) => intent.deadline <= now,
    );

    for (const intent of missedFills) {
      await this.slashMissedFill(intent.intentId, intent.solver, now);
      slashedCount++;
    }

    return { expiredCount, slashedCount, durationMs: Date.now() - startMs };
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
  ) {
    const reason = "accepted intent not filled before deadline";

    await this.intentsService.update(intentId, {
      state: "slashed",
      slashedAt: now,
      slashReason: reason,
    });
    this.intentsGateway.broadcast({ type: "intent_slashed", intentId, solver, reason });

    if (!solver) {
      // Shouldn't happen in practice — an "accepted" intent always has a
      // solver — but don't let a bad record throw the whole sweep cycle.
      console.error(`[sweeper] intent ${intentId} was accepted with no solver on record`);
      return;
    }

    await this.solversService.recordFailedFill(solver);
    const slashRecord = await this.solversService.recordSlash(solver, intentId, reason, now);

    const result = await this.solverRegistryService.slashSolver({
      solverAddress: solver,
      intentId,
      reason,
    });
    console.log(
      `[sweeper] slashed solver=${solver} for intent=${intentId}: ${result.detail} slashId=${slashRecord?.slashId ?? "unknown"}`,
    );
  }
}
