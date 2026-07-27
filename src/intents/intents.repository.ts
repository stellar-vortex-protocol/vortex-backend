import { Intent, IntentState } from "./intents.types";

/**
 * NestJS injection token for the intents repository.
 *
 * Use this token instead of a concrete class so any module can swap
 * InMemoryIntentsRepository for a Prisma-backed or on-chain adapter
 * without touching IntentsService.
 *
 * @example
 *   \@Inject(INTENTS_REPOSITORY) private readonly repo: IIntentsRepository
 */
export const INTENTS_REPOSITORY = Symbol("INTENTS_REPOSITORY");

/**
 * Storage contract for intents.
 *
 * All methods mirror the shape the rest of the application already relies on,
 * making it a drop-in replacement for the Map-based logic that previously
 * lived directly inside IntentsService.
 */
export interface IIntentsRepository {
  /**
   * Persist a fully-formed intent and return it.
   */
  save(intent: Intent): Intent;

  /**
   * Find a single intent by its public UUID.
   * Returns `undefined` when the intent does not exist.
   */
  findById(id: string): Intent | undefined;

  /**
   * Return all intents sorted by `createdAt` descending (newest first).
   */
  findAll(): Intent[];

  /**
   * Return all intents that match the given state, sorted newest-first.
   */
  findByState(state: IntentState): Intent[];

  /**
   * Return all intents belonging to `user` (case-insensitive), newest-first.
   */
  findByUser(user: string): Intent[];

  /**
   * Shallow-merge `patch` into the stored intent identified by `id`.
   * Returns the updated intent, or `null` if the intent does not exist.
   */
  update(id: string, patch: Partial<Intent>): Intent | null;
}
