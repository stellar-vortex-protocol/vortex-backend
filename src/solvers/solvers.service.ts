import { Inject, Injectable, Logger } from "@nestjs/common";
import { SupportedChain } from "../intents/intents.types";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord, SolverPendingPenalty } from "./solvers.types";

export type LeaderboardWindow = "24h" | "7d" | "30d" | "all";

export interface SlashDisputeRecord {
  submittedAt: number;
  reason: string;
  evidenceReference?: string;
}

export interface SlashRecord {
  slashId: string;
  solver: string;
  intentId: string;
  reason: string;
  timestamp: number;
  disputeStatus: "none" | "disputed" | "resolved-upheld" | "resolved-reversed";
  dispute?: SlashDisputeRecord;
}

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
  private readonly slashHistory = new Map<string, SlashRecord[]>();
  private readonly pendingPenalties = new Map<string, SolverPendingPenalty>();
  private slashSequence = 0;

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
      "registeredAt" | "lastActiveAt" | "fillsCompleted" | "fillsFailed" | "totalVolume"
    >,
  ): Promise<SolverRecord> {
    const now = Math.floor(Date.now() / 1000);
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: now,
      lastActiveAt: now,
    };
    return this.repo.save(solver);
  }

  async deregister(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async markLive(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: true, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async markOffline(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
    return this.repo.save(updated);
  }

  async deactivate(address: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, isActive: false, lastActiveAt: Math.floor(Date.now() / 1000) };
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

  async recordSlash(
    solverAddress: string,
    intentId: string,
    reason: string,
    timestamp: number,
  ): Promise<SlashRecord | null> {
    const solver = await this.repo.findByAddress(solverAddress);
    if (!solver) return null;

    const record: SlashRecord = {
      slashId: `slash-${++this.slashSequence}`,
      solver: solverAddress,
      intentId,
      reason,
      timestamp,
      disputeStatus: "none",
    };

    const existing = this.slashHistory.get(solverAddress) ?? [];
    existing.push(record);
    this.slashHistory.set(solverAddress, existing);
    return record;
  }

  async getSlashHistory(
    address: string,
    page = 1,
    pageSize = 25,
  ): Promise<{ records: SlashRecord[]; page: number; pageSize: number; total: number }> {
    const records = this.slashHistory.get(address) ?? [];
    const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const start = (page - 1) * pageSize;
    const pageRecords = sorted.slice(start, start + pageSize);

    return {
      records: pageRecords,
      page,
      pageSize,
      total: sorted.length,
    };
  }

  async submitDispute(
    address: string,
    slashId: string,
    reason: string,
    evidenceReference?: string,
  ): Promise<SlashRecord | null> {
    const records = this.slashHistory.get(address) ?? [];
    const record = records.find((entry) => entry.slashId === slashId);
    if (!record) return null;

    record.disputeStatus = "disputed";
    record.dispute = {
      submittedAt: Math.floor(Date.now() / 1000),
      reason,
      evidenceReference,
    };

    return record;
  }

  async resolveDispute(
    address: string,
    slashId: string,
    resolution: "resolved-upheld" | "resolved-reversed",
    reviewer?: string,
    note?: string,
  ): Promise<SlashRecord | null> {
    const records = this.slashHistory.get(address) ?? [];
    const record = records.find((entry) => entry.slashId === slashId);
    if (!record) return null;

    record.disputeStatus = resolution;
    if (!record.dispute) {
      record.dispute = {
        submittedAt: Math.floor(Date.now() / 1000),
        reason: note ?? "manual review",
        evidenceReference: reviewer ? `reviewer:${reviewer}` : undefined,
      };
    }

    return record;
  }
}
