import { Injectable } from "@nestjs/common";

/**
 * NestJS injection token for the on-chain outbox repository (issue #396).
 * Bound in IntentsModule to the in-memory or Prisma adapter, following
 * INTENTS_PERSISTENCE.
 */
export const OUTBOX_REPOSITORY = Symbol("OUTBOX_REPOSITORY");

/** Settlement-contract operations that flow through the outbox. */
export const OUTBOX_OPERATIONS = [
  "create_intent",
  "accept_intent",
  "fill_intent",
  "cancel_intent",
] as const;
export type OutboxOperation = (typeof OUTBOX_OPERATIONS)[number];

/**
 * Row lifecycle:
 *
 *   pending ──claim──▶ processing ──submit──▶ submitted ──confirm──▶ confirmed
 *      ▲                   │  │                   │
 *      └──── retry ────────┘  └─dry-run─▶ simulated│
 *      ▲                                          │
 *      └──────────── tx failed / expired ─────────┘
 *   any retry past OUTBOX_MAX_ATTEMPTS ──▶ dead  (alerted; blocks later rows
 *                                                for the same intent)
 */
export type OutboxStatus =
  | "pending"
  | "processing"
  | "submitted"
  | "confirmed"
  | "simulated"
  | "dead";

/** Statuses after which the next row for the same intent may proceed. */
export const OUTBOX_DONE_STATUSES: readonly OutboxStatus[] = ["confirmed", "simulated"];

export interface OutboxEntry {
  /** Monotonic sequence (bigint serialized as string); defines per-intent order. */
  id: string;
  intentId: string;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  /**
   * Number of claims so far. Also the fencing token: every state change after
   * a claim is conditional on `attempts` still matching, so a worker whose
   * lease expired cannot overwrite the row after another worker reclaimed it.
   */
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date;
  envelopeHash?: string;
  txHash?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOutboxEntry {
  intentId: string;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
}

/** The only outbox capability intent-mutating code needs inside a transaction. */
export interface IOutboxWriter {
  enqueue(entry: NewOutboxEntry): Promise<OutboxEntry>;
}

export interface IOutboxRepository extends IOutboxWriter {
  /**
   * Atomically claims up to `limit` due rows and moves them to `processing`
   * (attempts + 1, lockedUntil = `leaseUntil`). A row is due when it is
   * `pending` with nextAttemptAt <= now, or `processing` with an expired lease
   * (its worker crashed). Only the head row per intent is eligible — every
   * earlier row for that intent must be in {@link OUTBOX_DONE_STATUSES} —
   * which gives per-intent ordering while different intents run in parallel.
   * The Prisma adapter uses `FOR UPDATE SKIP LOCKED`.
   */
  claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxEntry[]>;

  /** Rows waiting on confirmation, oldest first. */
  findSubmitted(limit: number): Promise<OutboxEntry[]>;

  findByIntent(intentId: string): Promise<OutboxEntry[]>;

  countByStatus(): Promise<Record<OutboxStatus, number>>;

  /** Persists the signed envelope hash before broadcast. Fenced on `attempts`. */
  recordEnvelope(entry: OutboxEntry, envelopeHash: string): Promise<boolean>;

  markSubmitted(entry: OutboxEntry, txHash: string): Promise<boolean>;

  markConfirmed(entry: OutboxEntry, txHash: string): Promise<boolean>;

  markSimulated(entry: OutboxEntry): Promise<boolean>;

  /** Back to `pending` at `nextAttemptAt`; clears the envelope so it is rebuilt. */
  scheduleRetry(entry: OutboxEntry, error: string, nextAttemptAt: Date): Promise<boolean>;

  markDead(entry: OutboxEntry, error: string): Promise<boolean>;

  /**
   * Back to `pending` at `nextAttemptAt` *without* consuming the claim's
   * attempt (attempts - 1). Used when a kill-switch pause blocked the write,
   * so an emergency pause can never dead-letter rows.
   */
  release(entry: OutboxEntry, note: string, nextAttemptAt: Date): Promise<boolean>;

  /** Operator action: `dead` → `pending` with attempts reset. */
  requeueDead(id: string): Promise<boolean>;
}

export function emptyStatusCounts(): Record<OutboxStatus, number> {
  return { pending: 0, processing: 0, submitted: 0, confirmed: 0, simulated: 0, dead: 0 };
}

/**
 * In-memory adapter — development and tests. Single-process only; the Node
 * event loop makes each method atomic because none of them await.
 */
@Injectable()
export class InMemoryOutboxRepository implements IOutboxRepository {
  private readonly rows = new Map<string, OutboxEntry>();
  private sequence = 0n;

  async enqueue(entry: NewOutboxEntry): Promise<OutboxEntry> {
    const now = new Date();
    const row: OutboxEntry = {
      ...entry,
      id: (++this.sequence).toString(),
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxEntry[]> {
    const claimed: OutboxEntry[] = [];
    const headSeen = new Set<string>();
    for (const row of this.ordered()) {
      if (claimed.length >= limit) break;
      if (OUTBOX_DONE_STATUSES.includes(row.status)) continue;
      // First unfinished row for this intent is its head; anything after it waits.
      if (headSeen.has(row.intentId)) continue;
      headSeen.add(row.intentId);

      const due =
        (row.status === "pending" && row.nextAttemptAt <= now) ||
        (row.status === "processing" && row.lockedUntil !== undefined && row.lockedUntil < now);
      if (!due) continue;

      Object.assign(row, {
        status: "processing",
        attempts: row.attempts + 1,
        lockedUntil: leaseUntil,
        updatedAt: now,
      });
      claimed.push({ ...row });
    }
    return claimed;
  }

  async findSubmitted(limit: number): Promise<OutboxEntry[]> {
    return this.ordered()
      .filter((r) => r.status === "submitted")
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async findByIntent(intentId: string): Promise<OutboxEntry[]> {
    return this.ordered()
      .filter((r) => r.intentId === intentId)
      .map((r) => ({ ...r }));
  }

  async countByStatus(): Promise<Record<OutboxStatus, number>> {
    const counts = emptyStatusCounts();
    for (const row of this.rows.values()) counts[row.status]++;
    return counts;
  }

  async recordEnvelope(entry: OutboxEntry, envelopeHash: string): Promise<boolean> {
    return this.fenced(entry, ["processing"], { envelopeHash });
  }

  async markSubmitted(entry: OutboxEntry, txHash: string): Promise<boolean> {
    return this.fenced(entry, ["processing"], { status: "submitted", txHash, lockedUntil: undefined });
  }

  async markConfirmed(entry: OutboxEntry, txHash: string): Promise<boolean> {
    return this.fenced(entry, ["processing", "submitted"], {
      status: "confirmed",
      txHash,
      lockedUntil: undefined,
    });
  }

  async markSimulated(entry: OutboxEntry): Promise<boolean> {
    return this.fenced(entry, ["processing"], { status: "simulated", lockedUntil: undefined });
  }

  async scheduleRetry(entry: OutboxEntry, error: string, nextAttemptAt: Date): Promise<boolean> {
    return this.fenced(entry, ["processing", "submitted"], {
      status: "pending",
      nextAttemptAt,
      lastError: error,
      lockedUntil: undefined,
      envelopeHash: undefined,
      txHash: undefined,
    });
  }

  async markDead(entry: OutboxEntry, error: string): Promise<boolean> {
    return this.fenced(entry, ["processing", "submitted"], {
      status: "dead",
      lastError: error,
      lockedUntil: undefined,
    });
  }

  async release(entry: OutboxEntry, note: string, nextAttemptAt: Date): Promise<boolean> {
    return this.fenced(entry, ["processing"], {
      status: "pending",
      attempts: Math.max(0, entry.attempts - 1),
      nextAttemptAt,
      lastError: note,
      lockedUntil: undefined,
      envelopeHash: undefined,
    });
  }

  async requeueDead(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "dead") return false;
    Object.assign(row, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      envelopeHash: undefined,
      txHash: undefined,
      updatedAt: new Date(),
    });
    return true;
  }

  private ordered(): OutboxEntry[] {
    return [...this.rows.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  private fenced(
    entry: OutboxEntry,
    from: OutboxStatus[],
    patch: Partial<OutboxEntry>,
  ): boolean {
    const row = this.rows.get(entry.id);
    if (!row || row.attempts !== entry.attempts || !from.includes(row.status)) return false;
    Object.assign(row, patch, { updatedAt: new Date() });
    return true;
  }
}
