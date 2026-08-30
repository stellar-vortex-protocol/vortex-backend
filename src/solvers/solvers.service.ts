import { Inject, Injectable } from "@nestjs/common";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord } from "./solvers.types";

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
  private readonly slashHistory = new Map<string, SlashRecord[]>();
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

  async markLive(address: string): Promise<SolverRecord | undefined> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return undefined;
    const updated = { ...solver, isActive: true };
    return this.repo.save(updated);
  }

  async markOffline(address: string): Promise<SolverRecord | undefined> {
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
   * deadline. Bumps the local fillsFailed counter for read paths (e.g. the
   * leaderboard); the authoritative bond reduction happens on-chain via
   * SolverRegistryService.slashSolver and should reconcile bondAmount here
   * once event ingestion exists (see docs/architecture/onchain-settlement.md).
   */
  async recordFailedFill(address: string): Promise<SolverRecord | null> {
    const solver = await this.repo.findByAddress(address);
    if (!solver) return null;
    const updated = { ...solver, fillsFailed: solver.fillsFailed + 1 };
    return this.repo.save(updated);
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
