import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverRegistryService } from "../soroban/solver-registry.service";

const SWEEP_INTERVAL_MS = 30_000;

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

  async sweep() {
    const startMs = Date.now();
    const now = Math.floor(startMs / 1000);
    let expiredCount = 0;

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

    // Step 1: record a pending penalty (optimistic fillsFailed bump).
    // At this point the slash is detected locally but not yet confirmed
    // on-chain.  The solver's record enters "pending" state.
    await this.solversService.recordFailedFill(solver, intentId);

    // Step 2: submit the on-chain slash.  If submission fails we roll back
    // the pending penalty so the solver is not permanently penalised for a
    // slash that was never enforced.  If it succeeds, EventIngestionService
    // will call confirmPenalty() once the solver_slashed event arrives.
    try {
      const result = await this.solverRegistryService.slashSolver({
        solverAddress: solver,
        intentId,
        reason,
      });
      console.log(
        `[sweeper] slash submitted: solver=${solver} intent=${intentId} detail=${result.detail} — awaiting on-chain confirmation`,
      );
    } catch (err) {
      console.error(
        `[sweeper] on-chain slash submission FAILED for solver=${solver} intent=${intentId}: ${(err as Error).message} — rolling back pending penalty`,
      );
      await this.solversService.rollbackPenalty(intentId);
    }
  }
}
