import { SolverRecord } from "./solvers.types";

/**
 * NestJS injection token for the solvers repository.
 *
 * Use this token instead of a concrete class so any module can swap
 * InMemorySolversRepository for a Prisma-backed adapter without touching
 * SolversService.
 *
 * @example
 *   \@Inject(SOLVERS_REPOSITORY) private readonly repo: ISolversRepository
 */
export const SOLVERS_REPOSITORY = Symbol("SOLVERS_REPOSITORY");

/**
 * Storage contract for solver records.
 *
 * Mirrors the shape SolversService already exposes so that swapping the
 * underlying adapter is a one-line change in SolversModule.
 *
 * Methods return synchronous values for the in-memory adapter and Promises
 * for the Prisma adapter — callers always `await` so both shapes work.
 */
export interface ISolversRepository {
  /**
   * Persist a fully-formed solver record and return it.
   * If a record with the same address already exists it is overwritten (upsert).
   */
  save(solver: SolverRecord): SolverRecord | Promise<SolverRecord>;

  /**
   * Find a solver by its unique address.
   * Returns `undefined` when no matching record exists.
   */
  findByAddress(address: string): SolverRecord | undefined | Promise<SolverRecord | undefined>;

  /**
   * Return all solver records (order is unspecified — callers sort as needed).
   */
  findAll(): SolverRecord[] | Promise<SolverRecord[]>;
}
