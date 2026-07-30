import { Injectable } from "@nestjs/common";
import { ISolversRepository } from "./solvers.repository";
import { SolverRecord } from "./solvers.types";
import { buildSeedSolvers } from "./solvers.seed";

/**
 * In-memory implementation of ISolversRepository.
 *
 * Stores solver records in a plain `Map` and seeds demo data on construction.
 * This adapter ships with the current in-memory backend; swap the binding in
 * SolversModule to replace it with a Prisma-backed adapter when the database
 * work (issue #36) lands — SolversService stays unchanged.
 */
@Injectable()
export class InMemorySolversRepository implements ISolversRepository {
  private readonly store = new Map<string, SolverRecord>();

  constructor() {
    this.seed();
  }

  save(solver: SolverRecord): SolverRecord {
    this.store.set(solver.address, solver);
    return solver;
  }

  findByAddress(address: string): SolverRecord | undefined {
    return this.store.get(address);
  }

  findAll(): SolverRecord[] {
    return [...this.store.values()];
  }

  // ── seed ────────────────────────────────────────────────────────────────────

  private seed(): void {
    for (const solver of buildSeedSolvers()) {
      this.store.set(solver.address, solver);
    }
  }
}
