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

  private seed() {
    for (const s of buildSeedSolvers()) {
      this.solvers.set(s.address, s);
    }
  }
}
