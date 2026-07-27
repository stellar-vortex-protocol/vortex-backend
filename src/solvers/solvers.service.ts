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

  getAll(): SolverRecord[] {
    return this.repo.findAll();
  }

  get(address: string): SolverRecord | undefined {
    return this.repo.findByAddress(address);
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
    return this.repo.save(solver);
  }
}
