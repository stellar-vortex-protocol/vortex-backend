import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState, SupportedChain } from "./intents.types";
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

type MaybePromise<T> = T | Promise<T>;

/**
 * Returned by a mutation whose `expectedVersion` no longer matches the stored
 * record (issue #405). Carries the version actually found so callers can
 * decide whether to re-read and retry or surface a conflict to the client.
 */
export class VersionConflict {
  readonly kind = "version_conflict" as const;

  constructor(
    readonly intentId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {}
}

/** Type guard for {@link VersionConflict}. */
export function isVersionConflict(value: unknown): value is VersionConflict {
  return value instanceof VersionConflict;
}

/**
 * Result of a mutation: the updated intent, `null` when the intent does not
 * exist or its state guard failed, or a {@link VersionConflict} when an
 * `expectedVersion` was supplied and did not match.
 */
export type MutationResult = Intent | null | VersionConflict;

/** Fields a generic `update()` may change — identity and version are managed by the repository. */
export type IntentPatch = Omit<Partial<Intent>, "intentId" | "version" | "createdAt">;

/** Result of {@link IIntentsRepository.createIdempotent}. */
export interface IdempotentCreateResult {
  intent: Intent;
  /** false when an unexpired intent already held the idempotency key. */
  created: boolean;
}

/**
 * Filter / sort / pagination parameters for advanced intent search (issue #440).
 *
 * All fields are optional; when none are present the search returns every
 * intent sorted by `createdAt` descending — identical to the pre-existing
 * default behaviour.
 */
export interface IntentSearchQuery {
  state?: IntentState;
  user?: string;
  chain?: SupportedChain;
  /** Minimum USD value at creation (inclusive). */
  minAmountUsd?: number;
  /** Maximum USD value at creation (inclusive). */
  maxAmountUsd?: number;
  /** Minimum creation time, unix epoch seconds (inclusive). */
  createdFrom?: number;
  /** Maximum creation time, unix epoch seconds (inclusive). */
  createdTo?: number;
  /** Source token symbol (case-insensitive). */
  srcToken?: string;
  /** Destination token symbol (case-insensitive). */
  dstToken?: string;
  /** Solver address that accepted/filled the intent. */
  solver?: string;
  /**
   * Sort dimension and direction: `created` | `deadline` | `usd`, optionally
   * with an `:asc` / `:desc` suffix. Defaults to `created:desc`.
   */
  sort?: string;
  limit?: number;
  offset?: number;
}

/** A page of search results plus the total number of matching intents. */
export interface IntentSearchResult {
  intents: Intent[];
  total: number;
}

/**
 * Storage contract for intent records.
 *
 * Every mutation increments `version` by exactly one, and every mutation
 * accepts an expected version so concurrent writers (HTTP handlers, the
 * sweeper, event ingestion, the deposit verifier) can never silently
 * overwrite one another (issue #405). Implementations must apply the state
 * guard, the version check, and the write as a single atomic step — for SQL
 * that means one `UPDATE … WHERE … RETURNING *` statement.
 *
 * All methods are synchronous for the in-memory adapter and return Promises
 * for the Prisma adapter — callers always `await` so both shapes work. The
 * shared contract suite in `intents-repository.contract.ts` runs against
 * every implementation.
 */
export interface IIntentsRepository {
  /**
   * Persist a fully-formed intent record exactly as given (including its
   * `version`) and return it. Used for creation and for mirroring rows between
   * stores; it is not a mutation path — use {@link update} to change a record.
   */
  save(intent: Intent): MaybePromise<Intent>;

  /**
   * Insert `intent` unless another intent created at or after
   * `minCreatedAt` already holds `idempotencyKey`, in which case that intent
   * is returned instead. Must be atomic across replicas (a unique index on the
   * key in SQL). A key held by an older intent is released and reused.
   */
  createIdempotent(
    intent: Intent,
    idempotencyKey: string,
    minCreatedAt: number,
  ): MaybePromise<IdempotentCreateResult>;

  /** Find the unexpired intent created with `idempotencyKey`, if any. */
  findByIdempotencyKey(idempotencyKey: string, minCreatedAt: number): MaybePromise<Intent | undefined>;

  /**
   * Find an intent by its unique intentId.
   * Returns `undefined` when no matching record exists.
   */
  findById(id: string): MaybePromise<Intent | undefined>;

  /** Fetch several intents in one call; unknown IDs are omitted. */
  findManyByIds(ids: string[]): MaybePromise<Intent[]>;

  /**
   * Return all intent records sorted by createdAt descending.
   */
  findAll(): MaybePromise<Intent[]>;

  /**
   * Return all intents matching the given state, sorted by createdAt descending.
   */
  findByState(state: IntentState): MaybePromise<Intent[]>;

  /**
   * Return all intents belonging to the given user (case-insensitive address match).
   */
  findByUser(user: string): MaybePromise<Intent[]>;

  /** Number of intents currently `accepted` by `solver`. */
  countAcceptedBySolver(solver: string): MaybePromise<number>;

  /** Number of `open` or `accepted` intents owned by `user` (case-insensitive). */
  countActiveByUser(user: string): MaybePromise<number>;

  /**
   * Apply `patch` only if the stored version equals `expectedVersion`:
   *   UPDATE intents SET …patch, version = version + 1
   *   WHERE intent_id = $1 AND version = $2 RETURNING *
   * Returns `null` when the intent does not exist.
   */
  update(id: string, patch: IntentPatch, expectedVersion?: number): MaybePromise<MutationResult>;

  /**
   * Amend the user-adjustable fields of an `open` intent while its deadline is
   * still in the future (issue #569): only `minDstAmount` and `deadline` may
   * change, and a new deadline must also lie in the future. Returns `null`
   * when the intent does not exist, is not open, or either deadline check
   * fails; the repository does not bump `version` (the amend is a widening of
   * terms, not a competing solver write).
   */
  amendIfOpen(
    id: string,
    patch: Pick<Intent, "minDstAmount" | "deadline">,
    now?: number,
  ): MaybePromise<Intent | null>;

  /**
   * Remove a stored intent. Used only for in-memory retention sweeps for stale
   * terminal-state records.
   */
  delete(id: string): MaybePromise<boolean>;

  /**
   * Atomically transition an intent from `open` → `accepted` while its
   * deadline is still in the future (issue #473):
   *   UPDATE intents SET state='accepted', solver=$2, deadline=$3, version=version+1
   *   WHERE intent_id=$1 AND state='open' AND deadline > $now [AND version=$v] RETURNING *
   * Returns `null` when the intent is not found, already taken, or past its
   * deadline (the sweeper wins that race). `now` defaults to the current time.
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
    expectedVersion?: number,
  ): MaybePromise<MutationResult>;

  /**
   * Atomically transition an intent from `accepted` → `filled` only if it is
   * currently accepted by the specified solver AND the fill window has not
   * elapsed (issue #473). The `minDstAmount` invariant is enforced by the
   * controller before this write; the state + deadline predicates make the
   * write itself race-free.
   */
  fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    now?: number,
    expectedVersion?: number,
  ): MaybePromise<MutationResult>;

  /**
   * Atomically push an accepted intent's deadline out to `newDeadline`, only
   * while it is still `accepted` and its deadline is earlier (issue #477):
   *   UPDATE intents SET deadline=$2, version=version+1
   *   WHERE intent_id=$1 AND state='accepted' AND deadline < $2 [AND version=$v] RETURNING *
   * While an emergency pause covers `fill`, the sweeper extends windows instead
   * of slashing. The `deadline < $2` guard makes repeat calls no-ops and never
   * shortens a window; a concurrent fill or slash wins via the state predicate.
   */
  extendDeadlineIfAccepted(
    id: string,
    newDeadline: number,
    expectedVersion?: number,
  ): MaybePromise<MutationResult>;

  /** Atomically transition an intent from `open` → `cancelled`. */
  cancelIfOpen(id: string, expectedVersion?: number): MaybePromise<MutationResult>;

  /**
   * Atomically transition an intent from `open` → `expired`. Guards the
   * sweeper's expiry pass against a concurrent user cancel() or solver accept().
   */
  expireIfOpen(id: string, expectedVersion?: number): MaybePromise<MutationResult>;

  /**
   * Atomically transition an intent from `accepted` → `slashed`. Guards the
   * sweeper's slashing pass against a concurrent solver fill().
   */
  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): MaybePromise<MutationResult>;
}

/** Options for {@link InMemoryIntentsRepository}. */
export interface InMemoryIntentsRepositoryOptions {
  /** Seed demo intents on construction (default true). Disabled in `dual` mode. */
  seed?: boolean;
}

/**
 * In-memory implementation of IIntentsRepository.
 *
 * Stores intents in a plain `Map`. Every method runs synchronously, so each
 * check-and-write is atomic within the Node.js event loop — this is the
 * reference behaviour the Prisma adapter reproduces with single SQL statements.
 */
@Injectable()
export class InMemoryIntentsRepository implements IIntentsRepository {
  private readonly store = new Map<string, Intent>();
  private readonly idempotencyKeys = new Map<string, string>();

  constructor(options: InMemoryIntentsRepositoryOptions = {}) {
    if (options.seed ?? true) this.seed();
  }

  save(intent: Intent): Intent {
    this.store.set(intent.intentId, intent);
    return intent;
  }

  createIdempotent(intent: Intent, idempotencyKey: string, minCreatedAt: number): IdempotentCreateResult {
    const existing = this.findByIdempotencyKey(idempotencyKey, minCreatedAt);
    if (existing) return { intent: existing, created: false };
    this.store.set(intent.intentId, intent);
    this.idempotencyKeys.set(idempotencyKey, intent.intentId);
    return { intent, created: true };
  }

  findByIdempotencyKey(idempotencyKey: string, minCreatedAt: number): Intent | undefined {
    const intentId = this.idempotencyKeys.get(idempotencyKey);
    if (!intentId) return undefined;
    const intent = this.store.get(intentId);
    if (!intent || intent.createdAt < minCreatedAt) {
      this.idempotencyKeys.delete(idempotencyKey);
      return undefined;
    }
    return intent;
  }

  findById(id: string): Intent | undefined {
    return this.store.get(id);
  }

  findManyByIds(ids: string[]): Intent[] {
    return [...new Set(ids)]
      .map((id) => this.store.get(id))
      .filter((intent): intent is Intent => intent !== undefined);
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

  /**
   * Advanced search with filtering, sorting and pagination (issue #440).
   * Mirrors the SQL adapter's semantics in memory so both stores satisfy
   * `intents-search.spec.ts`.
   */
  search(query: IntentSearchQuery): IntentSearchResult {
    let results = this.findAll();

    if (query.state !== undefined) results = results.filter((i) => i.state === query.state);
    if (query.user !== undefined) {
      const needle = query.user.toLowerCase();
      results = results.filter((i) => i.user.toLowerCase() === needle);
    }
    if (query.chain !== undefined) results = results.filter((i) => i.srcChain === query.chain);
    if (query.solver !== undefined) {
      const needle = query.solver.toLowerCase();
      results = results.filter((i) => i.solver !== undefined && i.solver.toLowerCase() === needle);
    }
    if (query.minAmountUsd !== undefined) {
      results = results.filter(
        (i) => i.usdValueAtCreate !== undefined && i.usdValueAtCreate >= query.minAmountUsd!,
      );
    }
    if (query.maxAmountUsd !== undefined) {
      results = results.filter(
        (i) => i.usdValueAtCreate !== undefined && i.usdValueAtCreate <= query.maxAmountUsd!,
      );
    }
    if (query.createdFrom !== undefined) results = results.filter((i) => i.createdAt >= query.createdFrom!);
    if (query.createdTo !== undefined) results = results.filter((i) => i.createdAt <= query.createdTo!);
    if (query.srcToken !== undefined) {
      const needle = query.srcToken.toLowerCase();
      results = results.filter((i) => i.srcToken.symbol.toLowerCase() === needle);
    }
    if (query.dstToken !== undefined) {
      const needle = query.dstToken.toLowerCase();
      results = results.filter((i) => i.dstToken.symbol.toLowerCase() === needle);
    }

    // Sorting — default createdAt desc (preserves pre-existing behaviour).
    const [dimension, direction] = (query.sort ?? "created:desc").split(":");
    const dir = direction === "asc" ? 1 : -1;
    results.sort((a, b) => {
      switch (dimension) {
        case "deadline":
          return (a.deadline - b.deadline) * dir;
        case "usd": {
          const av = a.usdValueAtCreate ?? 0;
          const bv = b.usdValueAtCreate ?? 0;
          return (av - bv) * dir;
        }
        case "created":
        default:
          return (a.createdAt - b.createdAt) * dir;
      }
    });

    const total = results.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    const page = results.slice(offset, offset + limit);
    return { intents: page, total };
  }

  countAcceptedBySolver(solver: string): number {
    let count = 0;
    for (const intent of this.store.values()) {
      if (intent.state === "accepted" && intent.solver === solver) count++;
    }
    return count;
  }

  countActiveByUser(user: string): number {
    const needle = user.toLowerCase();
    let count = 0;
    for (const intent of this.store.values()) {
      if ((intent.state === "open" || intent.state === "accepted") && intent.user.toLowerCase() === needle) {
        count++;
      }
    }
    return count;
  }

  update(id: string, patch: IntentPatch, expectedVersion?: number): MutationResult {
    return this.mutate(id, expectedVersion, () => true, (existing) => ({ ...existing, ...patch }));
  }

  amendIfOpen(
    id: string,
    patch: Pick<Intent, "minDstAmount" | "deadline">,
    now = Math.floor(Date.now() / 1000),
  ): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open" || existing.deadline <= now || patch.deadline <= now) {
      return null;
    }
    const updated: Intent = { ...existing, ...patch };
    this.store.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
    expectedVersion?: number,
  ): MutationResult {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    return this.mutate(
      id,
      expectedVersion,
      (i) => i.state === "open" && i.deadline > nowSec,
      (i) => ({ ...i, state: "accepted", solver, deadline: newDeadline }),
    );
  }

  fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    now?: number,
    expectedVersion?: number,
  ): MutationResult {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    return this.mutate(
      id,
      expectedVersion,
      (i) => i.state === "accepted" && i.solver === solver && i.deadline > nowSec,
      (i) => ({ ...i, ...patch, state: "filled" }),
    );
  }

  extendDeadlineIfAccepted(id: string, newDeadline: number, expectedVersion?: number): MutationResult {
    return this.mutate(
      id,
      expectedVersion,
      (i) => i.state === "accepted" && i.deadline < newDeadline,
      (i) => ({ ...i, deadline: newDeadline }),
    );
  }

  cancelIfOpen(id: string, expectedVersion?: number): MutationResult {
    return this.mutate(id, expectedVersion, (i) => i.state === "open", (i) => ({ ...i, state: "cancelled" }));
  }

  expireIfOpen(id: string, expectedVersion?: number): MutationResult {
    return this.mutate(id, expectedVersion, (i) => i.state === "open", (i) => ({ ...i, state: "expired" }));
  }

  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): MutationResult {
    return this.mutate(
      id,
      expectedVersion,
      (i) => i.state === "accepted",
      (i) => ({ ...i, ...patch, state: "slashed" }),
    );
  }

  /**
   * Shared check-and-write. Mirrors the SQL adapter's classification: a
   * version mismatch is reported as a conflict before the state guard is
   * consulted, exactly as `WHERE version = $v AND state = …` followed by a
   * classifying re-read behaves.
   */
  private mutate(
    id: string,
    expectedVersion: number | undefined,
    guard: (intent: Intent) => boolean,
    apply: (intent: Intent) => Intent,
  ): MutationResult {
    const existing = this.store.get(id);
    if (!existing) return null;
    const existingVersion = existing.version ?? 0;
    if (expectedVersion !== undefined && existingVersion !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existingVersion);
    }
    if (!guard(existing)) return null;
    const updated: Intent = { ...apply(existing), intentId: id, version: existingVersion + 1 };
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
        version: 0,
        srcVerified: true,
        srcVerification: { status: "skipped", checkedAt: now, detail: "demo seed data" },
      };
      this.store.set(intent.intentId, intent);
    }
  }
}
