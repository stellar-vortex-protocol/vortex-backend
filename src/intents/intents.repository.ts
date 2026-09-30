import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";
import { intentExposureUsdMicros } from "./intent-exposure";

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
   * Remove a stored intent. Used only for in-memory retention sweeps for stale
   * terminal-state records; Prisma-backed stores ignore this call by design.
   */
  delete(id: string): boolean | Promise<boolean>;

  /**
   * Atomically transition an intent from `open` → `accepted` only if it is
   * currently in the `open` state AND its deadline is still in the future.
   * Mirrors the DB pattern:
   *   UPDATE intents SET state='accepted', solver=$2, deadline=$3
   *   WHERE intent_id=$1 AND state='open' AND deadline > $4
   *   RETURNING *
   * Returns the updated intent on success, `null` when the intent is not
   * found, already taken, or past deadline (sweeper wins the race).
   *
   * Lock ordering (issue #473): callers holding a per-solver advisory lock
   * must acquire it BEFORE invoking this method; this method itself only
   * touches the single intent row so no lock inversion is possible.
   */
  acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
  ): Intent | null | Promise<Intent | null>;

  /**
   * Atomically enforce the solver-wide accepted-exposure cap and accept an
   * open intent. Implementations must serialize this check per solver.
   */
  acceptIfOpenWithinExposure(
    id: string,
    solver: string,
    newDeadline: number,
    now: number,
    candidateExposureUsdMicros: bigint,
    maxExposureUsdMicros: bigint,
  ): Promise<{ intent: Intent | null; exposureExceeded: boolean }> | { intent: Intent | null; exposureExceeded: boolean };

  /**
   * Atomically transition an intent from `accepted` → `filled` only if it is
   * currently accepted by the specified solver AND the fill window has not
   * elapsed. Mirrors the DB pattern:
   *   UPDATE intents SET state='filled', ...patch
   *   WHERE intent_id=$1 AND state='accepted' AND solver=$2 AND deadline > $3
   *   RETURNING *
   * Returns the updated intent on success, `null` on any guard failure.
   * The `minDstAmount` invariant (fill >= minDst) is enforced by the
   * controller/service layer with bigint comparison before this write; the
   * state+deadline predicates here make the write itself race-free.
   */
  fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
    now?: number,
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
   * Atomically push an accepted intent's deadline out to at least `newDeadline`,
   * only while it is still in the `accepted` state.  Mirrors the DB pattern:
   *   UPDATE intents SET deadline=$2
   *   WHERE intent_id=$1 AND state='accepted' AND deadline < $2
   *   RETURNING *
   *
   * Issue #477: while an emergency pause covers `fill`, the sweeper cannot slash
   * missed fills — but leaving the deadline untouched would expire those intents
   * on the next cycle anyway and penalise the solver for a pause they did not
   * cause.  The `deadline < $2` guard makes this idempotent and never shortens
   * a window, and the state predicate means a concurrent fill or slash wins.
   *
   * Returns the updated intent, or `null` when the intent is no longer accepted
   * or already has a later deadline.
   */
  extendDeadlineIfAccepted(
    id: string,
    newDeadline: number,
  ): Intent | null | Promise<Intent | null>;

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

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  acceptIfOpen(id: string, solver: string, newDeadline: number, now?: number): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    // Deadline predicate pushed into the atomic check (issue #473): a solver
    // racing the sweeper past expiry must lose even in-process.
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    if (existing.deadline <= nowSec) return null;
    const updated: Intent = { ...existing, state: "accepted", solver, deadline: newDeadline };
    this.store.set(id, updated);
    return updated;
  }

  acceptIfOpenWithinExposure(
    id: string,
    solver: string,
    newDeadline: number,
    now: number,
    candidateExposureUsdMicros: bigint,
    maxExposureUsdMicros: bigint,
  ): { intent: Intent | null; exposureExceeded: boolean } {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open" || existing.deadline <= now) {
      return { intent: null, exposureExceeded: false };
    }
    let acceptedExposure = 0n;
    for (const intent of this.store.values()) {
      if (intent.state === "accepted" && intent.solver?.toLowerCase() === solver.toLowerCase()) {
        acceptedExposure += intentExposureUsdMicros(intent, now);
      }
    }
    if (acceptedExposure + candidateExposureUsdMicros > maxExposureUsdMicros) {
      return { intent: null, exposureExceeded: true };
    }
    const updated: Intent = { ...existing, state: "accepted", solver, deadline: newDeadline };
    this.store.set(id, updated);
    return { intent: updated, exposureExceeded: false };
  }

  fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
    now?: number,
  ): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted" || existing.solver !== solver) return null;
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    if (existing.deadline <= nowSec) return null;
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

  extendDeadlineIfAccepted(id: string, newDeadline: number): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted") return null;
    // Never shorten: a later deadline is left untouched so repeated sweeps are
    // no-ops rather than a countdown.
    if (existing.deadline >= newDeadline) return null;
    const updated: Intent = { ...existing, deadline: newDeadline };
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
