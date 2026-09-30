import { Prisma, PendingSlash as PendingSlashRow } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  IPendingSlashesRepository,
  NewPendingSlash,
  PendingSlash,
  PendingSlashPatch,
  PendingSlashState,
} from "./pending-slashes.repository";

/**
 * Prisma adapter for the slashing saga (issue #397). Every state change is a
 * single conditional `updateMany`, so concurrent pipeline workers and admin
 * requests are arbitrated by the database.
 */
export class PrismaPendingSlashesRepository implements IPendingSlashesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createIfAbsent(input: NewPendingSlash): Promise<{ slash: PendingSlash; created: boolean }> {
    try {
      const row = await this.prisma.pendingSlash.create({ data: { ...input, state: "detected" } });
      return { slash: fromRow(row), created: true };
    } catch (err) {
      // P2002 = unique constraint violation on intent_id: already detected.
      if ((err as Prisma.PrismaClientKnownRequestError).code !== "P2002") throw err;
      const existing = await this.prisma.pendingSlash.findUniqueOrThrow({
        where: { intentId: input.intentId },
      });
      return { slash: fromRow(existing), created: false };
    }
  }

  async findByIntent(intentId: string): Promise<PendingSlash | undefined> {
    const row = await this.prisma.pendingSlash.findUnique({ where: { intentId } });
    return row ? fromRow(row) : undefined;
  }

  async list(filter: { state?: PendingSlashState; limit: number }): Promise<PendingSlash[]> {
    const rows = await this.prisma.pendingSlash.findMany({
      where: filter.state ? { state: filter.state } : undefined,
      orderBy: { detectedAt: "desc" },
      take: filter.limit,
    });
    return rows.map(fromRow);
  }

  async findDue(now: Date, limit: number): Promise<PendingSlash[]> {
    const rows = await this.prisma.pendingSlash.findMany({
      where: {
        AND: [
          { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
          {
            OR: [
              { state: "detected" },
              { state: "challenge_window", challengeEndsAt: { lte: now }, nextAttemptAt: { lte: now } },
              { state: "submitted", simulated: false, nextAttemptAt: { lte: now } },
            ],
          },
        ],
      },
      orderBy: { detectedAt: "asc" },
      take: limit,
    });
    return rows.map(fromRow);
  }

  async claim(intentId: string, now: Date, leaseUntil: Date): Promise<boolean> {
    const result = await this.prisma.pendingSlash.updateMany({
      where: { intentId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: leaseUntil },
    });
    return result.count > 0;
  }

  async transition(
    intentId: string,
    from: PendingSlashState[],
    patch: PendingSlashPatch,
    now?: Date,
  ): Promise<PendingSlash | null> {
    const where: Prisma.PendingSlashWhereInput = { intentId, state: { in: from } };
    if (now) where.OR = [{ lockedUntil: null }, { lockedUntil: { lt: now } }];
    const result = await this.prisma.pendingSlash.updateMany({
      where,
      data: { ...toData(patch), lockedUntil: null },
    });
    if (result.count === 0) return null;
    const row = await this.prisma.pendingSlash.findUnique({ where: { intentId } });
    return row ? fromRow(row) : null;
  }
}

function toData(patch: PendingSlashPatch): Prisma.PendingSlashUpdateManyMutationInput {
  const data: Prisma.PendingSlashUpdateManyMutationInput = {};
  for (const [key, value] of Object.entries(patch)) {
    // undefined means "leave as is"; clearing a column is not needed by the saga.
    if (value !== undefined) (data as Record<string, unknown>)[key] = value;
  }
  return data;
}

function fromRow(row: PendingSlashRow): PendingSlash {
  return {
    id: row.id,
    intentId: row.intentId,
    solverAddress: row.solverAddress,
    reason: row.reason,
    state: row.state as PendingSlashState,
    fillDeadline: row.fillDeadline,
    detectedAt: row.detectedAt,
    challengeEndsAt: row.challengeEndsAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lockedUntil: row.lockedUntil ?? undefined,
    txHash: row.txHash ?? undefined,
    simulated: row.simulated,
    submittedAt: row.submittedAt ?? undefined,
    confirmedAt: row.confirmedAt ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
    cancelReason: row.cancelReason ?? undefined,
    cancelledBy: row.cancelledBy ?? undefined,
    fillTxHash: row.fillTxHash ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
