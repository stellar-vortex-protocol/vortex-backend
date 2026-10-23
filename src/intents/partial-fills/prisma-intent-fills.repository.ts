import { Prisma, IntentFill as IntentFillRow } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { IntentFill } from "../intents.types";
import { planReservation } from "./partial-fill.math";
import { IIntentFillsRepository, newFillRow, ReserveRequest, ReserveResult } from "./intent-fills.repository";

/**
 * Postgres adapter for partial-fill tranches (issue #427).
 *
 * {@link reserve} runs in one transaction that first takes a row lock on the
 * parent intent:
 *
 *   SELECT 1 FROM intents WHERE intent_id = $1 AND state = 'open' FOR UPDATE
 *
 * Every concurrent reserver for the same intent queues on that lock, so the
 * tranche read → {@link planReservation} → insert sequence is serialised and
 * Σ reserved can never exceed `src_amount`, across replicas. Status changes
 * are single conditional `UPDATE … WHERE status = 'reserved'` statements.
 */
export class PrismaIntentFillsRepository implements IIntentFillsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(request: ReserveRequest, isOpen: () => Promise<boolean> | boolean): Promise<ReserveResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ intent_id: string }[]>(
        Prisma.sql`SELECT intent_id FROM intents WHERE intent_id = ${request.intentId} AND state = 'open' FOR UPDATE`,
      );
      if (locked.length === 0 || !(await isOpen())) {
        return { ok: false as const, reason: "intent_not_open" as const, remaining: "0" };
      }
      const rows = await tx.intentFill.findMany({ where: { intentId: request.intentId } });
      const plan = planReservation({
        srcAmount: request.srcAmount,
        minFillAmount: request.minFillAmount,
        fills: rows.map(fromRow),
        amount: request.amount,
      });
      if (!plan.ok) return { ok: false as const, reason: plan.reason, remaining: plan.remaining.toString() };
      const fill = newFillRow(request);
      const created = await tx.intentFill.create({
        data: {
          id: fill.fillId,
          intentId: fill.intentId,
          solver: fill.solver,
          reservedAmount: fill.reservedAmount,
          minDstAmount: fill.minDstAmount,
          status: "reserved",
          reservedAt: fill.reservedAt,
          deadline: fill.deadline,
        },
      });
      return { ok: true as const, fill: fromRow(created) };
    });
  }

  async findById(fillId: string): Promise<IntentFill | undefined> {
    const row = await this.prisma.intentFill.findUnique({ where: { id: fillId } });
    return row ? fromRow(row) : undefined;
  }

  async listByIntent(intentId: string): Promise<IntentFill[]> {
    const rows = await this.prisma.intentFill.findMany({ where: { intentId }, orderBy: { reservedAt: "asc" } });
    return rows.map(fromRow);
  }

  async intentIdsWithFills(intentIds: readonly string[]): Promise<Set<string>> {
    if (intentIds.length === 0) return new Set();
    const rows = await this.prisma.intentFill.findMany({
      where: { intentId: { in: [...intentIds] } },
      select: { intentId: true },
      distinct: ["intentId"],
    });
    return new Set(rows.map((r) => r.intentId));
  }

  async findExpiredReservations(now: number, limit = 500): Promise<IntentFill[]> {
    const rows = await this.prisma.intentFill.findMany({
      where: { status: "reserved", deadline: { lte: now } },
      orderBy: { deadline: "asc" },
      take: limit,
    });
    return rows.map(fromRow);
  }

  async markFilled(
    fillId: string,
    solver: string,
    patch: { dstAmount: string; feeAmount: string; txHash?: string; filledAt: number },
  ): Promise<IntentFill | null> {
    return this.conditional(
      { id: fillId, status: "reserved", solver, deadline: { gt: patch.filledAt } },
      {
        status: "filled",
        dstAmount: patch.dstAmount,
        feeAmount: patch.feeAmount,
        txHash: patch.txHash ?? null,
        filledAt: patch.filledAt,
      },
    );
  }

  async markSlashed(fillId: string, now: number): Promise<IntentFill | null> {
    return this.conditional({ id: fillId, status: "reserved", deadline: { lte: now } }, { status: "slashed", slashedAt: now });
  }

  async markReleased(fillId: string, now: number): Promise<IntentFill | null> {
    return this.conditional({ id: fillId, status: "reserved" }, { status: "released", releasedAt: now });
  }

  private async conditional(
    where: Prisma.IntentFillWhereInput & { id: string },
    data: Prisma.IntentFillUpdateManyMutationInput,
  ): Promise<IntentFill | null> {
    const { count } = await this.prisma.intentFill.updateMany({ where, data });
    if (count === 0) return null;
    const row = await this.prisma.intentFill.findUnique({ where: { id: where.id } });
    return row ? fromRow(row) : null;
  }
}

function fromRow(row: IntentFillRow): IntentFill {
  return {
    fillId: row.id,
    intentId: row.intentId,
    solver: row.solver,
    reservedAmount: row.reservedAmount,
    minDstAmount: row.minDstAmount,
    status: row.status,
    reservedAt: row.reservedAt,
    deadline: row.deadline,
    ...(row.dstAmount !== null ? { dstAmount: row.dstAmount } : {}),
    ...(row.feeAmount !== null ? { feeAmount: row.feeAmount } : {}),
    ...(row.txHash !== null ? { txHash: row.txHash } : {}),
    ...(row.filledAt !== null ? { filledAt: row.filledAt } : {}),
    ...(row.slashedAt !== null ? { slashedAt: row.slashedAt } : {}),
    ...(row.releasedAt !== null ? { releasedAt: row.releasedAt } : {}),
  };
}
