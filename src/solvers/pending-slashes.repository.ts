import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";

/** Injection token for {@link IPendingSlashesRepository} (issue #397). */
export const PENDING_SLASHES_REPOSITORY = Symbol("PENDING_SLASHES_REPOSITORY");

/**
 * Slash saga states:
 *
 *   detected ──▶ challenge_window ──(window over, re-verified)──▶ submitted ──▶ confirmed
 *      │               │                                              │
 *      └───────────────┴──(fill proof / admin / give-up)──▶ cancelled ◀┘ (tx failed past retries)
 */
export const PENDING_SLASH_STATES = [
  "detected",
  "challenge_window",
  "submitted",
  "confirmed",
  "cancelled",
] as const;
export type PendingSlashState = (typeof PENDING_SLASH_STATES)[number];

export interface PendingSlash {
  id: string;
  intentId: string;
  solverAddress: string;
  reason: string;
  state: PendingSlashState;
  /** The fill deadline (unix seconds) the solver missed. */
  fillDeadline: number;
  detectedAt: Date;
  challengeEndsAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  txHash?: string;
  /** Registry client simulated but did not broadcast (dry-run / gated submit). */
  simulated: boolean;
  submittedAt?: Date;
  confirmedAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  cancelledBy?: string;
  fillTxHash?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewPendingSlash {
  intentId: string;
  solverAddress: string;
  reason: string;
  fillDeadline: number;
  detectedAt: Date;
  challengeEndsAt: Date;
}

export type PendingSlashPatch = Partial<
  Omit<PendingSlash, "id" | "intentId" | "solverAddress" | "createdAt" | "updatedAt">
>;

export interface IPendingSlashesRepository {
  /**
   * Inserts a `detected` row unless one already exists for the intent — the
   * unique constraint on intent_id is what makes slashing exactly-once.
   */
  createIfAbsent(input: NewPendingSlash): Promise<{ slash: PendingSlash; created: boolean }>;

  findByIntent(intentId: string): Promise<PendingSlash | undefined>;

  list(filter: { state?: PendingSlashState; limit: number }): Promise<PendingSlash[]>;

  /**
   * Rows the pipeline should act on now and that are not leased:
   * `detected`; `challenge_window` past both challengeEndsAt and nextAttemptAt;
   * non-simulated `submitted` past nextAttemptAt.
   */
  findDue(now: Date, limit: number): Promise<PendingSlash[]>;

  /** Takes the processing lease if it is free or expired. */
  claim(intentId: string, now: Date, leaseUntil: Date): Promise<boolean>;

  /**
   * Conditional update: applies `patch` only if the row is in one of `from`,
   * and — when `now` is given — only if no *other* holder's lease is active.
   * Always clears the lease. Returns the updated row, or null if the guard failed.
   */
  transition(
    intentId: string,
    from: PendingSlashState[],
    patch: PendingSlashPatch,
    now?: Date,
  ): Promise<PendingSlash | null>;
}

/** In-memory adapter (dev/test). Each method is atomic — none of them await. */
@Injectable()
export class InMemoryPendingSlashesRepository implements IPendingSlashesRepository {
  private readonly rows = new Map<string, PendingSlash>();

  async createIfAbsent(input: NewPendingSlash): Promise<{ slash: PendingSlash; created: boolean }> {
    const existing = this.rows.get(input.intentId);
    if (existing) return { slash: { ...existing }, created: false };
    const now = new Date();
    const row: PendingSlash = {
      ...input,
      id: uuidv4(),
      state: "detected",
      attempts: 0,
      nextAttemptAt: now,
      simulated: false,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.intentId, row);
    return { slash: { ...row }, created: true };
  }

  async findByIntent(intentId: string): Promise<PendingSlash | undefined> {
    const row = this.rows.get(intentId);
    return row ? { ...row } : undefined;
  }

  async list(filter: { state?: PendingSlashState; limit: number }): Promise<PendingSlash[]> {
    return [...this.rows.values()]
      .filter((r) => !filter.state || r.state === filter.state)
      .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
      .slice(0, filter.limit)
      .map((r) => ({ ...r }));
  }

  async findDue(now: Date, limit: number): Promise<PendingSlash[]> {
    return [...this.rows.values()]
      .filter((r) => !r.lockedUntil || r.lockedUntil < now)
      .filter(
        (r) =>
          r.state === "detected" ||
          (r.state === "challenge_window" && r.challengeEndsAt <= now && r.nextAttemptAt <= now) ||
          (r.state === "submitted" && !r.simulated && r.nextAttemptAt <= now),
      )
      .sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async claim(intentId: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const row = this.rows.get(intentId);
    if (!row || (row.lockedUntil && row.lockedUntil >= now)) return false;
    row.lockedUntil = leaseUntil;
    row.updatedAt = now;
    return true;
  }

  async transition(
    intentId: string,
    from: PendingSlashState[],
    patch: PendingSlashPatch,
    now?: Date,
  ): Promise<PendingSlash | null> {
    const row = this.rows.get(intentId);
    if (!row || !from.includes(row.state)) return null;
    if (now && row.lockedUntil && row.lockedUntil >= now) return null;
    Object.assign(row, patch, { lockedUntil: undefined, updatedAt: new Date() });
    return { ...row };
  }
}
