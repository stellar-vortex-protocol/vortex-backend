import { Injectable } from "@nestjs/common";
import { SolverRecord } from "./solvers.types";
import { buildSeedSolvers } from "./solvers.seed";

@Injectable()
export class SolversService {
  private readonly solvers = new Map<string, SolverRecord>();

  constructor() {
    this.seed();
  }

  getAll(): SolverRecord[] {
    return [...this.solvers.values()];
  }

  get(address: string): SolverRecord | undefined {
    return this.solvers.get(address);
  }

  register(
    data: Omit<SolverRecord, "registeredAt" | "fillsCompleted" | "fillsFailed" | "totalVolume">,
  ): SolverRecord {
    const solver: SolverRecord = {
      ...data,
      fillsCompleted: 0,
      fillsFailed: 0,
      totalVolume: "0",
      registeredAt: Math.floor(Date.now() / 1000),
    };
    this.solvers.set(solver.address, solver);
    return solver;
  }

  /**
   * Records that a solver accepted an intent and then missed its fill
   * deadline. Bumps the local fillsFailed counter for read paths (e.g. the
   * leaderboard); the authoritative bond reduction happens on-chain via
   * SolverRegistryService.slashSolver and should reconcile bondAmount here
   * once event ingestion exists (see docs/architecture/onchain-settlement.md).
   */
  recordFailedFill(address: string): SolverRecord | null {
    const solver = this.solvers.get(address);
    if (!solver) return null;
    const updated = { ...solver, fillsFailed: solver.fillsFailed + 1 };
    this.solvers.set(address, updated);
    return updated;
  }

  private seed() {
    for (const s of buildSeedSolvers()) {
      this.solvers.set(s.address, s);
    }
  }
}
