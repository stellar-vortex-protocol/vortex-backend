import { Inject, Injectable, Logger } from "@nestjs/common";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord, SolverPendingPenalty } from "./solvers.types";

/**
 * Orchestration layer for solver records.
 *
 * Business logic (counter initialisation, timestamp generation) lives here.
 * All persistence is delegated to the injected ISolversRepository so the
 * storage adapter can be swapped (in-memory → Prisma) without touching this
 * service or anything above it.
 */
@Injectable()
export class SolversService {
  private readonly logger = new Logger(SolversService.name);

  /**
   * In-memory pending-penalty map: intentId → SolverPendingPenalty.
   *
   * Tracks slashes that the sweeper has dispatched on-chain but that have
   * not yet been confirmed by a solver_slashed contract event.  The map is
   * intentionally keyed by intentId (not solverAddress) because a single
   * solver can have multiple concurrent pending penalties and each penalty
   * is uniquely tied to one missed-deadline intent.
   *
   * Lifecycle:
   *   1. slashMissedFill (IntentsSweeperService) calls recordPendingPenalty →
   *      state = "pending", fillsFailed bumped.
   *   2a. On-chain slash confirmed → EventIngestionService calls
   *       confirmPenalty(intentId, slashAmount) → state = "confirmed",
   *       bondAmount reconciled downward.
   *   2b. On-chain slash fails/never confirms → sweeper or event-ingestion
   *       service calls rollbackPenalty(intentId) → state = "failed",
   *       fillsFailed decremented so the solver is not permanently penalised
   *       for an unenforced slash.
   */
  readonly pendingPenalties = new Map<string, SolverPendingPenalty>();

  constructor(
    @Inject(SOLVERS_REPOSITORY)
    private readonly repo: ISolversRepository,
  ) {}

  async getAll(): Promise<SolverRecord[]> {
    return this.repo.findAll();
  }

  async get(address: string): Promise<SolverRecord | undefined> {
    return this.repo.findByAddress(address);
  }

  async register(
    data: Omit<
      SolverRecord,
      "registeredAt" | "fillsCompleted" | "fillsFailed" | "totalVolume"
    >,
  ): Promise<SolverRecord> {
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: Math.floor(Date.now() / 1000),
    };
    return this.repo.save(solver);
  }

  async deregister(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false };
    return this.repo.save(updated);
  }

  async deactivate(address: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: false };
    return this.repo.save(updated);
  }

  async reactivate(address: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: true };
    return this.repo.save(updated);
  }

  /**
   * Records that a solver accepted an intent and then missed its fill
   * deadline by entering a pending-slash state.
   *
   * Bumps the local fillsFailed counter immediately (optimistic increment)
   * and stores a "pending" penalty entry so callers can later either confirm
   * the penalty once the on-chain slash event arrives, or roll it back if the
   * on-chain submission never confirms.
   *
   * The authoritative bond reduction happens on-chain via
   * SolverRegistryService.slashSolver; bondAmount is reconciled in
   * confirmPenalty() once the solver_slashed event is observed.
   */
  async recordFailedFill(address: string, intentId: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, fillsFailed: solver.fillsFailed + 1 };
    const saved = await this.repo.save(updated);

    // Track this as a pending penalty until on-chain confirmation.
    this.pendingPenalties.set(intentId, {
      intentId,
      solverAddress: address,
      detectedAt: Math.floor(Date.now() / 1000),
      state: "pending",
    });

    return saved;
  }

  /**
   * Confirms a pending penalty once the solver_slashed on-chain event is
   * ingested by EventIngestionService.
   *
   * Reconciles the solver's bondAmount downward by slashAmount and marks the
   * penalty as "confirmed" so the in-memory record reflects the real on-chain
   * balance.
   *
   * @param intentId   The intent whose slash is now confirmed on-chain.
   * @param slashAmount  The amount slashed from the solver's bond (as a string,
   *                     matching bondAmount's representation).
   */
  async confirmPenalty(intentId: string, slashAmount: string): Promise<SolverRecord | null> {
    const penalty = this.pendingPenalties.get(intentId);
    if (!penalty || penalty.state !== "pending") {
      this.logger.warn(
        `confirmPenalty called for intentId=${intentId} but no pending penalty found (state=${penalty?.state ?? "none"})`,
      );
      return null;
    }

    const solver = await this.repo.findByAddress(penalty.solverAddress);
    if (!solver) {
      this.logger.error(
        `confirmPenalty: solver ${penalty.solverAddress} not found when confirming slash for intent ${intentId}`,
      );
      return null;
    }

    // Reconcile bondAmount: clamp to 0 so we never go negative.
    const current = BigInt(solver.bondAmount);
    const slash = BigInt(slashAmount);
    const newBond = current > slash ? current - slash : 0n;

    const updated = { ...solver, bondAmount: newBond.toString() };
    const saved = await this.repo.save(updated);

    this.pendingPenalties.set(intentId, {
      ...penalty,
      state: "confirmed",
      confirmedSlashAmount: slashAmount,
    });

    this.logger.log(
      `[penalty] confirmed: solver=${penalty.solverAddress} intent=${intentId} slashed=${slashAmount} newBond=${newBond}`,
    );

    return saved;
  }

  /**
   * Rolls back a pending penalty when the on-chain slash submission fails or
   * is never confirmed.
   *
   * Decrements fillsFailed (reversing the optimistic increment from
   * recordFailedFill) and marks the penalty as "failed" so operators can
   * investigate the discrepancy.
   *
   * @param intentId  The intent whose slash submission failed.
   */
  async rollbackPenalty(intentId: string): Promise<SolverRecord | null> {
    const penalty = this.pendingPenalties.get(intentId);
    if (!penalty || penalty.state !== "pending") {
      this.logger.warn(
        `rollbackPenalty called for intentId=${intentId} but no pending penalty found (state=${penalty?.state ?? "none"})`,
      );
      return null;
    }

    const solver = await this.repo.findByAddress(penalty.solverAddress);
    if (!solver) {
      this.logger.error(
        `rollbackPenalty: solver ${penalty.solverAddress} not found when rolling back penalty for intent ${intentId}`,
      );
      return null;
    }

    // Clamp at 0 to guard against double-rollback edge cases.
    const newFailed = Math.max(0, solver.fillsFailed - 1);
    const updated = { ...solver, fillsFailed: newFailed };
    const saved = await this.repo.save(updated);

    this.pendingPenalties.set(intentId, { ...penalty, state: "failed" });

    this.logger.warn(
      `[penalty] rolled back: solver=${penalty.solverAddress} intent=${intentId} (on-chain slash did not confirm)`,
    );

    return saved;
  }
}
