import { Prisma, OnchainOutbox, OutboxStatus as PrismaOutboxStatus } from "@prisma/client";
import {
  IOutboxRepository,
  NewOutboxEntry,
  OUTBOX_DONE_STATUSES,
  OutboxEntry,
  OutboxOperation,
  OutboxStatus,
  emptyStatusCounts,
} from "./outbox.repository";

/** PrismaService or the client handed to a `$transaction` callback. */
export type OutboxPrismaClient = Prisma.TransactionClient;

/** Raw row shape returned by the claim query (snake_case columns). */
interface RawOutboxRow {
  id: bigint;
  intent_id: string;
  operation: string;
  payload: Prisma.JsonValue;
  status: PrismaOutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  locked_until: Date | null;
  envelope_hash: string | null;
  tx_hash: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Prisma-backed outbox (issue #396).
 *
 * Constructed either with PrismaService (relay worker) or with a transaction
 * client (inside IntentsUnitOfWork) so `enqueue` commits atomically with the
 * intent mutation it mirrors.
 */
export class PrismaOutboxRepository implements IOutboxRepository {
  constructor(private readonly prisma: OutboxPrismaClient) {}

  async enqueue(entry: NewOutboxEntry): Promise<OutboxEntry> {
    const row = await this.prisma.onchainOutbox.create({
      data: {
        intentId: entry.intentId,
        operation: entry.operation,
        payload: entry.payload as Prisma.InputJsonObject,
      },
    });
    return fromModel(row);
  }

  /**
   * Single statement: pick the per-intent head rows that are due, lock them
   * with SKIP LOCKED so concurrent relays partition the work, and flip them to
   * `processing`. The NOT EXISTS clause treats every non-done earlier row
   * (including `dead`) as blocking, which is what guarantees per-intent order.
   */
  async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxEntry[]> {
    const done = Prisma.join(OUTBOX_DONE_STATUSES.map((s) => Prisma.sql`${s}::"OutboxStatus"`));
    const rows = await this.prisma.$queryRaw<RawOutboxRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT c.id
        FROM onchain_outbox c
        WHERE (
                (c.status = 'pending' AND c.next_attempt_at <= ${now})
             OR (c.status = 'processing' AND c.locked_until < ${now})
              )
          AND NOT EXISTS (
                SELECT 1 FROM onchain_outbox p
                WHERE p.intent_id = c.intent_id
                  AND p.id < c.id
                  AND p.status NOT IN (${done})
              )
        ORDER BY c.id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE onchain_outbox o
      SET status = 'processing',
          attempts = o.attempts + 1,
          locked_until = ${leaseUntil},
          updated_at = NOW()
      FROM candidates
      WHERE o.id = candidates.id
      RETURNING o.*
    `);
    return rows.map(fromRaw).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async findSubmitted(limit: number): Promise<OutboxEntry[]> {
    const rows = await this.prisma.onchainOutbox.findMany({
      where: { status: "submitted" },
      orderBy: { id: "asc" },
      take: limit,
    });
    return rows.map(fromModel);
  }

  async findByIntent(intentId: string): Promise<OutboxEntry[]> {
    const rows = await this.prisma.onchainOutbox.findMany({
      where: { intentId },
      orderBy: { id: "asc" },
    });
    return rows.map(fromModel);
  }

  async countByStatus(): Promise<Record<OutboxStatus, number>> {
    const groups = await this.prisma.onchainOutbox.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts = emptyStatusCounts();
    for (const g of groups) counts[g.status as OutboxStatus] = g._count._all;
    return counts;
  }

  recordEnvelope(entry: OutboxEntry, envelopeHash: string): Promise<boolean> {
    return this.fenced(entry, ["processing"], { envelopeHash });
  }

  markSubmitted(entry: OutboxEntry, txHash: string): Promise<boolean> {
    return this.fenced(entry, ["processing"], { status: "submitted", txHash, lockedUntil: null });
  }

  markConfirmed(entry: OutboxEntry, txHash: string): Promise<boolean> {
    return this.fenced(entry, ["processing", "submitted"], {
      status: "confirmed",
      txHash,
      lockedUntil: null,
    });
  }

  markSimulated(entry: OutboxEntry): Promise<boolean> {
    return this.fenced(entry, ["processing"], { status: "simulated", lockedUntil: null });
  }

  scheduleRetry(entry: OutboxEntry, error: string, nextAttemptAt: Date): Promise<boolean> {
    return this.fenced(entry, ["processing", "submitted"], {
      status: "pending",
      nextAttemptAt,
      lastError: error,
      lockedUntil: null,
      envelopeHash: null,
      txHash: null,
    });
  }

  markDead(entry: OutboxEntry, error: string): Promise<boolean> {
    return this.fenced(entry, ["processing", "submitted"], {
      status: "dead",
      lastError: error,
      lockedUntil: null,
    });
  }

  release(entry: OutboxEntry, note: string, nextAttemptAt: Date): Promise<boolean> {
    return this.fenced(entry, ["processing"], {
      status: "pending",
      attempts: Math.max(0, entry.attempts - 1),
      nextAttemptAt,
      lastError: note,
      lockedUntil: null,
      envelopeHash: null,
    });
  }

  async requeueDead(id: string): Promise<boolean> {
    const result = await this.prisma.onchainOutbox.updateMany({
      where: { id: BigInt(id), status: "dead" },
      data: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        envelopeHash: null,
        txHash: null,
      },
    });
    return result.count > 0;
  }

  private async fenced(
    entry: OutboxEntry,
    from: OutboxStatus[],
    data: Prisma.OnchainOutboxUpdateManyMutationInput,
  ): Promise<boolean> {
    const result = await this.prisma.onchainOutbox.updateMany({
      where: { id: BigInt(entry.id), attempts: entry.attempts, status: { in: from } },
      data,
    });
    return result.count > 0;
  }
}

function fromModel(row: OnchainOutbox): OutboxEntry {
  return {
    id: row.id.toString(),
    intentId: row.intentId,
    operation: row.operation as OutboxOperation,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lockedUntil: row.lockedUntil ?? undefined,
    envelopeHash: row.envelopeHash ?? undefined,
    txHash: row.txHash ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fromRaw(row: RawOutboxRow): OutboxEntry {
  return fromModel({
    id: row.id,
    intentId: row.intent_id,
    operation: row.operation,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedUntil: row.locked_until,
    envelopeHash: row.envelope_hash,
    txHash: row.tx_hash,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
