import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

/**
 * NestJS injection token for the intents repository.
 *
 * Use this token instead of a concrete class so any module can swap
 * InMemoryIntentsRepository for a Prisma-backed adapter without touching
 * IntentsService.
 *
 * @example
 *   \@Inject(INTENTS_REPOSITORY) private readonly repo: IIntentsRepository
 */
export const INTENTS_REPOSITORY = Symbol("INTENTS_REPOSITORY");

/**
 * Storage contract for intent records.
 *
 * All methods are synchronous for the in-memory adapter and return Promises
 * for the Prisma adapter — callers always `await` so both shapes work.
 */
export interface IIntentsRepository {
  /**
   * Persist a fully-formed intent record and return it.
   * If a record with the same intentId already exists it is overwritten.
   */
  save(intent: Intent): Intent | Promise<Intent>;

  /**
   * Find an intent by its unique intentId.
   * Returns `undefined` when no matching record exists.
   */
  findById(id: string): Intent | undefined | Promise<Intent | undefined>;

  /**
   * Return all intent records sorted by createdAt descending.
   */
  findAll(): Intent[] | Promise<Intent[]>;

  /**
   * Return all intents matching the given state, sorted by createdAt descending.
   */
  findByState(state: IntentState): Intent[] | Promise<Intent[]>;

  /**
   * Return all intents belonging to the given user (case-insensitive address match).
   */
  findByUser(user: string): Intent[] | Promise<Intent[]>;

  /**
   * Apply a partial patch to an existing intent and return the updated record.
   * Returns `null` when no record with the given id exists.
   */
  update(id: string, patch: Partial<Intent>): Intent | null | Promise<Intent | null>;

  /**
   * Atomically transition an intent from `open` → `accepted` only if it is
   * currently in the `open` state.  Mirrors the DB pattern:
   *   UPDATE intents SET state='accepted', solver=$2, deadline=$3
   *   WHERE intent_id=$1 AND state='open'
   *   RETURNING *
   * Returns the updated intent on success, `null` when the intent is not
   * found or is not in the `open` state (already taken by another solver).
   */
  acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
  ): Intent | null | Promise<Intent | null>;

  /**
   * Atomically transition an intent from `accepted` → `filled` only if it is
   * currently accepted by the specified solver.  Mirrors the DB pattern:
   *   UPDATE intents SET state='filled', ...patch
   *   WHERE intent_id=$1 AND state='accepted' AND solver=$2
   *   RETURNING *
   * Returns the updated intent on success, `null` on any guard failure.
   */
  fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
  ): Intent | null | Promise<Intent | null>;

  /**
   * Atomically transition an intent from `open` → `cancelled` only if it is
   * currently in the `open` state.  Mirrors the DB pattern:
   *   UPDATE intents SET state='cancelled'
   *   WHERE intent_id=$1 AND state='open'
   *   RETURNING *
   * Returns the updated intent on success, `null` when the intent is not
   * found or is not in the `open` state (e.g. already accepted or expired).
   */
  cancelIfOpen(id: string): Intent | null | Promise<Intent | null>;

  /**
   * Atomically transition an intent from `open` → `expired` only if it is
   * currently in the `open` state.  Guards the sweeper's expiry pass against
   * a concurrent user cancel() or solver accept() on the same intent.
   */
  expireIfOpen(id: string): Intent | null | Promise<Intent | null>;

  /**
   * Atomically transition an intent from `accepted` → `slashed` only if it is
   * currently in the `accepted` state.  Guards the sweeper's slashing pass
   * against a concurrent solver fill().
   */
  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
  ): Intent | null | Promise<Intent | null>;
}

/**
 * In-memory implementation of IIntentsRepository.
 *
 * Stores intents in a plain `Map` and seeds demo data on construction.
 * This adapter ships with the current in-memory backend; swap the binding in
 * IntentsModule to replace it with a Prisma-backed adapter — IntentsService
 * stays unchanged.
 */
@Injectable()
export class InMemoryIntentsRepository implements IIntentsRepository {
  private readonly store = new Map<string, Intent>();

  constructor() {
    this.seed();
  }

  save(intent: Intent): Intent {
    this.store.set(intent.intentId, intent);
    return intent;
  }

  findById(id: string): Intent | undefined {
    return this.store.get(id);
  }

  findAll(): Intent[] {
    return [...this.store.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  findByState(state: IntentState): Intent[] {
    return this.findAll().filter((i) => i.state === state);
  }

  findByUser(user: string): Intent[] {
    return this.findAll().filter((i) => i.user.toLowerCase() === user.toLowerCase());
  }

  update(id: string, patch: Partial<Intent>): Intent | null {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: Intent = { ...existing, ...patch };
    this.store.set(id, updated);
    return updated;
  }

  acceptIfOpen(id: string, solver: string, newDeadline: number): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    const updated: Intent = { ...existing, state: "accepted", solver, deadline: newDeadline };
    this.store.set(id, updated);
    return updated;
  }

  fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
  ): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted" || existing.solver !== solver) return null;
    const updated: Intent = { ...existing, ...patch, state: "filled" };
    this.store.set(id, updated);
    return updated;
  }

  cancelIfOpen(id: string): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    const updated: Intent = { ...existing, state: "cancelled" };
    this.store.set(id, updated);
    return updated;
  }

  expireIfOpen(id: string): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    const updated: Intent = { ...existing, state: "expired" };
    this.store.set(id, updated);
    return updated;
  }

  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
  ): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted") return null;
    const updated: Intent = { ...existing, ...patch, state: "slashed" };
    this.store.set(id, updated);
    return updated;
  }

  // ── seed ────────────────────────────────────────────────────────────────────

  seed(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
      };
      this.store.set(intent.intentId, intent);
    }
  }
}
