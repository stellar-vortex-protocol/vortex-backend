import { Inject, Injectable } from "@nestjs/common";
import { SOLVERS_REPOSITORY, ISolversRepository } from "./solvers.repository";
import { SolverRecord } from "./solvers.types";

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
    const updated = { ...solver, isActive };
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
}
