import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IIntentsRepository } from "./intents.repository";
import { Intent, IntentState, StellarToken, TokenInfo } from "./intents.types";
import { IntentState as PrismaIntentState, Prisma } from "@prisma/client";

/**
 * Prisma-backed implementation of IIntentsRepository.
 *
 * All mutating operations that must be race-free (`acceptIfOpen`,
 * `fillIfAccepted`) use a single conditional `updateMany` call so the
 * database enforces the state guard atomically — no separate read-then-write.
 *
 * Bigint amounts (srcAmount, minDstAmount, fillAmount, quotedDstAmount) are
 * stored and returned as strings per the project's bigint-as-string convention
 * (see CONTRIBUTING.md).  JSON columns (srcToken, dstToken) are cast back to
 * their TypeScript types on the way out.
 */
@Injectable()
export class PrismaIntentsRepository implements IIntentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(intent: Intent): Promise<Intent> {
    const data = this.toDbData(intent);
    await this.prisma.intent.upsert({
      where: { intentId: intent.intentId },
      create: { ...data, intentId: intent.intentId },
      update: data,
    });
    return intent;
  }

  async findById(id: string): Promise<Intent | undefined> {
    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : undefined;
  }

  async findAll(): Promise<Intent[]> {
    const rows = await this.prisma.intent.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.fromRow(r));
  }

  async findByState(state: IntentState): Promise<Intent[]> {
    const rows = await this.prisma.intent.findMany({
      where: { state: this.toPrismaState(state) },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.fromRow(r));
  }

  async findByUser(user: string): Promise<Intent[]> {
    // Postgres is case-sensitive; normalise the address comparison in-query.
    const rows = await this.prisma.intent.findMany({
      where: { user: { equals: user, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.fromRow(r));
  }

  async update(id: string, patch: Partial<Intent>): Promise<Intent | null> {
    try {
      const row = await this.prisma.intent.update({
        where: { intentId: id },
        data: this.toDbPatch(patch),
      });
      return this.fromRow(row);
    } catch (err) {
      // P2025 = Record to update not found
      if ((err as Prisma.PrismaClientKnownRequestError).code === "P2025") return null;
      throw err;
    }
  }

  /**
   * Atomically accept an intent only when it is currently `open`.
   *
   * Uses a single `updateMany` with a compound WHERE clause so the database
   * enforces the state guard — zero rows updated means another solver already
   * won the race.
   */
  async acceptIfOpen(id: string, solver: string, newDeadline: number): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: { intentId: id, state: PrismaIntentState.open },
      data: {
        state: PrismaIntentState.accepted,
        solver,
        deadline: newDeadline,
      },
    });

    if (result.count === 0) return null; // not found or already taken

    // Fetch the updated row to return the full intent shape.
    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  /**
   * Atomically fill an intent only when it is currently `accepted` by the
   * specified solver.
   *
   * Uses a single `updateMany` with a compound WHERE clause — zero rows
   * updated means the intent was not in the expected state or assigned to a
   * different solver.
   */
  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
  ): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: {
        intentId: id,
        state: PrismaIntentState.accepted,
        solver,
      },
      data: {
        state: PrismaIntentState.filled,
        ...(patch.filledAt !== undefined ? { filledAt: patch.filledAt } : {}),
        ...(patch.fillAmount !== undefined ? { fillAmount: patch.fillAmount } : {}),
        ...(patch.txHash !== undefined ? { txHash: patch.txHash } : {}),
      },
    });

    if (result.count === 0) return null; // guard failed

    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  /**
   * Atomically cancel an intent only when it is currently `open`. Guards
   * against a concurrent solver accept() or sweeper expiry on the same intent.
   */
  async cancelIfOpen(id: string): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: { intentId: id, state: PrismaIntentState.open },
      data: { state: PrismaIntentState.cancelled },
    });

    if (result.count === 0) return null;

    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  /**
   * Atomically expire an intent only when it is currently `open`. Used by the
   * sweeper so a concurrent user cancel() or solver accept() always wins the race.
   */
  async expireIfOpen(id: string): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: { intentId: id, state: PrismaIntentState.open },
      data: { state: PrismaIntentState.expired },
    });

    if (result.count === 0) return null;

    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  /**
   * Atomically slash an intent only when it is currently `accepted`. Used by
   * the sweeper so a concurrent solver fill() always wins the race.
   */
  async slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
  ): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: { intentId: id, state: PrismaIntentState.accepted },
      data: { state: PrismaIntentState.slashed },
    });

    if (result.count === 0) return null;

    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Map Intent → Prisma create/update data (omits intentId which is the key). */
  private toDbData(
    intent: Intent,
  ): Omit<Prisma.IntentCreateInput, "intentId"> {
    return {
      user: intent.user,
      srcChain: intent.srcChain as Prisma.IntentCreateInput["srcChain"],
      srcToken: intent.srcToken as unknown as Prisma.InputJsonValue,
      srcAmount: intent.srcAmount,
      dstToken: intent.dstToken as unknown as Prisma.InputJsonValue,
      minDstAmount: intent.minDstAmount,
      quotedDstAmount: intent.quotedDstAmount ?? null,
      solver: intent.solver ?? null,
      state: this.toPrismaState(intent.state),
      createdAt: intent.createdAt,
      deadline: intent.deadline,
      filledAt: intent.filledAt ?? null,
      fillAmount: intent.fillAmount ?? null,
      txHash: intent.txHash ?? null,
    };
  }

  /** Build an `updateMany`-compatible data object from a partial Intent patch. */
  private toDbPatch(patch: Partial<Intent>): Prisma.IntentUpdateInput {
    const data: Prisma.IntentUpdateInput = {};
    if (patch.state !== undefined) data.state = this.toPrismaState(patch.state);
    if (patch.solver !== undefined) data.solver = patch.solver;
    if (patch.deadline !== undefined) data.deadline = patch.deadline;
    if (patch.filledAt !== undefined) data.filledAt = patch.filledAt;
    if (patch.fillAmount !== undefined) data.fillAmount = patch.fillAmount;
    if (patch.txHash !== undefined) data.txHash = patch.txHash;
    if (patch.quotedDstAmount !== undefined) data.quotedDstAmount = patch.quotedDstAmount;
    if (patch.srcAmount !== undefined) data.srcAmount = patch.srcAmount;
    if (patch.minDstAmount !== undefined) data.minDstAmount = patch.minDstAmount;
    if ("slashedAt" in patch && patch.slashedAt !== undefined) {
      // slashedAt / slashReason are not Prisma schema columns yet; ignore silently
      // until the schema migration lands (issue #62).
    }
    return data;
  }

  /** Map a Prisma Intent row → domain Intent. */
  private fromRow(row: {
    intentId: string;
    user: string;
    srcChain: string;
    srcToken: Prisma.JsonValue;
    srcAmount: string;
    dstToken: Prisma.JsonValue;
    minDstAmount: string;
    quotedDstAmount: string | null;
    solver: string | null;
    state: PrismaIntentState;
    createdAt: number;
    deadline: number;
    filledAt: number | null;
    fillAmount: string | null;
    txHash: string | null;
  }): Intent {
    return {
      intentId: row.intentId,
      user: row.user,
      srcChain: row.srcChain as Intent["srcChain"],
      srcToken: row.srcToken as unknown as TokenInfo,
      srcAmount: row.srcAmount,
      dstToken: row.dstToken as unknown as StellarToken,
      minDstAmount: row.minDstAmount,
      ...(row.quotedDstAmount !== null ? { quotedDstAmount: row.quotedDstAmount } : {}),
      ...(row.solver !== null ? { solver: row.solver } : {}),
      state: row.state as IntentState,
      createdAt: row.createdAt,
      deadline: row.deadline,
      ...(row.filledAt !== null ? { filledAt: row.filledAt } : {}),
      ...(row.fillAmount !== null ? { fillAmount: row.fillAmount } : {}),
      ...(row.txHash !== null ? { txHash: row.txHash } : {}),
    };
  }

  private toPrismaState(state: IntentState): PrismaIntentState {
    return state as PrismaIntentState;
  }
}
