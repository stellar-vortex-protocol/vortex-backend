import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IIntentsRepository, IntentSearchQuery, IntentSearchResult } from "./intents.repository";
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

  /**
   * Advanced search (issue #440) — filtering, sorting and pagination pushed
   * into the database query.
   *
   * Scalar filters use Prisma's typed where input; the JSONB token-symbol
   * filters use raw SQL (`lower(token->>'symbol') = lower($1)`) so they can
   * use the expression indexes created in the migration and stay
   * case-insensitive. Sorting and pagination are applied in the same query so
   * no supported combination falls back to a sequential scan + app-side slice.
   */
  async search(query: IntentSearchQuery): Promise<IntentSearchResult> {
    const where: Prisma.IntentWhereInput = {};

    if (query.state !== undefined) where.state = this.toPrismaState(query.state);
    if (query.chain !== undefined) where.srcChain = query.chain as Prisma.IntentWhereInput["srcChain"];
    if (query.user !== undefined) where.user = { equals: query.user, mode: "insensitive" };
    if (query.solver !== undefined) where.solver = { equals: query.solver, mode: "insensitive" };

    if (query.minAmountUsd !== undefined && query.maxAmountUsd !== undefined) {
      where.usdValueAtCreate = { gte: query.minAmountUsd, lte: query.maxAmountUsd };
    } else if (query.minAmountUsd !== undefined) {
      where.usdValueAtCreate = { gte: query.minAmountUsd };
    } else if (query.maxAmountUsd !== undefined) {
      where.usdValueAtCreate = { lte: query.maxAmountUsd };
    }

    if (query.createdFrom !== undefined && query.createdTo !== undefined) {
      where.createdAt = { gte: query.createdFrom, lte: query.createdTo };
    } else if (query.createdFrom !== undefined) {
      where.createdAt = { gte: query.createdFrom };
    } else if (query.createdTo !== undefined) {
      where.createdAt = { lte: query.createdTo };
    }

    // JSONB token-symbol filters — raw SQL so the expression indexes apply.
    const raw: Prisma.Sql[] = [];
    if (query.srcToken !== undefined) {
      raw.push(Prisma.sql`lower(src_token->>'symbol') = lower(${query.srcToken})`);
    }
    if (query.dstToken !== undefined) {
      raw.push(Prisma.sql`lower(dst_token->>'symbol') = lower(${query.dstToken})`);
    }
    if (raw.length > 0) {
      (where as { AND: unknown }).AND = raw;
    }

    // Sorting — default createdAt desc (preserves pre-existing behaviour).
    const [dimension, direction] = (query.sort ?? "created:desc").split(":");
    const dir = direction === "asc" ? ("asc" as const) : ("desc" as const);
    let orderBy: Prisma.IntentOrderByWithRelationInput;
    switch (dimension) {
      case "deadline":
        orderBy = { deadline: dir };
        break;
      case "usd":
        orderBy = { usdValueAtCreate: dir };
        break;
      case "created":
      default:
        orderBy = { createdAt: dir };
    }

    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;

    const [rows, total] = await Promise.all([
      this.prisma.intent.findMany({ where, orderBy, skip: offset, take: limit }),
      this.prisma.intent.count({ where }),
    ]);

    return { intents: rows.map((r) => this.fromRow(r)), total };
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

  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.intent.delete({ where: { intentId: id } });
      return true;
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === "P2025") return false;
      throw err;
    }
  }

  /**
   * Atomically accept an intent only when it is currently `open` AND its
   * deadline is still in the future (issue #473).
   *
   * Uses a single `updateMany` with a compound WHERE clause so the database
   * enforces the state + deadline guards — zero rows updated means another
   * solver already won the race or the sweeper already expired the intent.
   *
   * Lock ordering: callers enforcing per-solver caps must hold the solver
   * advisory lock (`pg_advisory_xact_lock`) BEFORE calling this method.
   */
  async acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
    acceptedDstAmount?: string,
  ): Promise<Intent | null> {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const result = await this.prisma.intent.updateMany({
      where: { intentId: id, state: PrismaIntentState.open, deadline: { gt: nowSec } },
      data: {
        state: PrismaIntentState.accepted,
        solver,
        deadline: newDeadline,
        ...(acceptedDstAmount !== undefined ? { acceptedDstAmount } : {}),
      },
    });

    if (result.count === 0) return null; // not found, already taken, or expired

    // Fetch the updated row to return the full intent shape.
    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  /**
   * Acquire a transaction-scoped advisory lock for a solver key (issue #473).
   *
   * Must be called inside a `$transaction` callback to serialize per-solver
   * cap checks across replicas. Lock ordering: solver lock BEFORE any intent
   * row write, released automatically at transaction end. No-op fallback when
   * the Prisma client does not expose `$executeRaw` (e.g. unit tests).
   */
  async acquireSolverLock(solver: string): Promise<void> {
    const client = this.prisma as unknown as {
      $executeRaw?: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    };
    if (typeof client.$executeRaw !== "function") return;
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${solver}))`;
  }

  /** Count open/accepted intents for a user with a single COUNT query. */
  async countOpenByUser(user: string): Promise<number> {
    return this.prisma.intent.count({
      where: {
        user: { equals: user, mode: "insensitive" },
        state: { in: [PrismaIntentState.open, PrismaIntentState.accepted] },
      },
    });
  }

  /**
   * Atomically fill an intent only when it is currently `accepted` by the
   * specified solver AND the fill window has not elapsed (issue #473).
   *
   * Uses a single `updateMany` with a compound WHERE clause — zero rows
   * updated means the intent was not in the expected state, is assigned to a
   * different solver, or the deadline passed (sweeper wins).
   */
  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Omit<Partial<Intent>, "state" | "solver">,
    now?: number,
  ): Promise<Intent | null> {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const result = await this.prisma.intent.updateMany({
      where: {
        intentId: id,
        state: PrismaIntentState.accepted,
        solver,
        deadline: { gt: nowSec },
      },
      data: {
        state: PrismaIntentState.filled,
        ...(patch.filledAt !== undefined ? { filledAt: patch.filledAt } : {}),
        ...(patch.fillAmount !== undefined ? { fillAmount: patch.fillAmount } : {}),
        ...(patch.feeAmount !== undefined
          ? { feeAmount: patch.feeAmount as string }
          : {}),
        ...(patch.txHash !== undefined ? { txHash: patch.txHash } : {}),
      },
    });

    if (result.count === 0) return null; // guard failed

    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? this.fromRow(row) : null;
  }

  /**
   * Atomically claims a tx hash for one accepted intent. The unique index on
   * intents.tx_hash arbitrates cross-intent races; the row predicate arbitrates
   * concurrent attempts to replace a hash on the same intent.
   */
  async reserveFillTxHash(id: string, solver: string, txHash: string): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: {
        intentId: id,
        state: PrismaIntentState.accepted,
        solver,
        OR: [{ txHash: null }, { txHash }],
      },
      data: {
        txHash,
        fillVerificationState: "pending",
        fillVerificationReason: null,
      },
    });
    if (result.count === 0) return null;
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

  /**
   * Issue #477 — push an accepted intent's deadline out during a fill pause.
   * The `deadline < newDeadline` predicate makes this a no-op once the window
   * is already long enough, so repeated sweep cycles cannot creep the deadline
   * forward indefinitely.
   */
  async extendDeadlineIfAccepted(id: string, newDeadline: number): Promise<Intent | null> {
    const result = await this.prisma.intent.updateMany({
      where: {
        intentId: id,
        state: PrismaIntentState.accepted,
        deadline: { lt: newDeadline },
      },
      data: { deadline: newDeadline },
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
    const data: Omit<Prisma.IntentCreateInput, "intentId"> & { feeAmount?: string | null } = {
      user: intent.user,
      srcChain: intent.srcChain as Prisma.IntentCreateInput["srcChain"],
      srcToken: intent.srcToken as unknown as Prisma.InputJsonValue,
      srcAmount: intent.srcAmount,
      dstToken: intent.dstToken as unknown as Prisma.InputJsonValue,
      minDstAmount: intent.minDstAmount,
      ...(intent.auction ? { auction: intent.auction as unknown as Prisma.InputJsonValue } : {}),
      acceptedDstAmount: intent.acceptedDstAmount ?? null,
      quotedDstAmount: intent.quotedDstAmount ?? null,
      solver: intent.solver ?? null,
      state: this.toPrismaState(intent.state),
      createdAt: intent.createdAt,
      deadline: intent.deadline,
      filledAt: intent.filledAt ?? null,
      fillAmount: intent.fillAmount ?? null,
      txHash: intent.txHash ?? null,
      ...(intent.usdValueAtCreate !== undefined
        ? { usdValueAtCreate: intent.usdValueAtCreate }
        : {}),
      fillVerificationState: intent.fillVerificationState ?? null,
      fillVerificationReason: intent.fillVerificationReason ?? null,
      fillVerifiedAt: intent.fillVerifiedAt ? new Date(intent.fillVerifiedAt) : null,
    };

    if (intent.feeAmount !== undefined) {
      (data as { feeAmount?: string | null }).feeAmount = intent.feeAmount ?? null;
    }

    return data;
  }

  /** Build an `updateMany`-compatible data object from a partial Intent patch. */
  private toDbPatch(patch: Partial<Intent>): Prisma.IntentUpdateInput {
    const data = {} as Prisma.IntentUpdateInput & { feeAmount?: string | null };
    if (patch.state !== undefined) data.state = this.toPrismaState(patch.state);
    if (patch.solver !== undefined) data.solver = patch.solver;
    if (patch.deadline !== undefined) data.deadline = patch.deadline;
    if (patch.filledAt !== undefined) data.filledAt = patch.filledAt;
    if (patch.fillAmount !== undefined) data.fillAmount = patch.fillAmount;
    if (patch.feeAmount !== undefined) (data as { feeAmount?: string | null }).feeAmount = patch.feeAmount ?? null;
    if (patch.txHash !== undefined) data.txHash = patch.txHash;
    if (patch.fillVerificationState !== undefined) data.fillVerificationState = patch.fillVerificationState;
    if (patch.fillVerificationReason !== undefined) data.fillVerificationReason = patch.fillVerificationReason;
    if (patch.fillVerifiedAt !== undefined) data.fillVerifiedAt = patch.fillVerifiedAt ? new Date(patch.fillVerifiedAt) : null;
    if (patch.quotedDstAmount !== undefined) data.quotedDstAmount = patch.quotedDstAmount;
    if (patch.srcAmount !== undefined) data.srcAmount = patch.srcAmount;
    if (patch.minDstAmount !== undefined) data.minDstAmount = patch.minDstAmount;
    if (patch.usdValueAtCreate !== undefined) data.usdValueAtCreate = patch.usdValueAtCreate;
    if (patch.auction !== undefined) {
      (data as Prisma.IntentUpdateInput & { auction?: Prisma.InputJsonValue }).auction =
        patch.auction as unknown as Prisma.InputJsonValue;
    }
    if (patch.acceptedDstAmount !== undefined) {
      (data as Prisma.IntentUpdateInput & { acceptedDstAmount?: string | null }).acceptedDstAmount =
        patch.acceptedDstAmount ?? null;
    }
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
    auction: Prisma.JsonValue | null;
    acceptedDstAmount: string | null;
    quotedDstAmount: string | null;
    solver: string | null;
    state: PrismaIntentState;
    createdAt: number;
    deadline: number;
    filledAt: number | null;
    fillAmount: string | null;
    feeAmount?: string | null;
    txHash: string | null;
    usdValueAtCreate?: number | null;
    fillVerificationState?: "pending" | "verified" | "rejected" | null;
    fillVerificationReason?: string | null;
    fillVerifiedAt?: Date | null;
  }): Intent {
    return {
      intentId: row.intentId,
      user: row.user,
      srcChain: row.srcChain as Intent["srcChain"],
      srcToken: row.srcToken as unknown as TokenInfo,
      srcAmount: row.srcAmount,
      dstToken: row.dstToken as unknown as StellarToken,
      minDstAmount: row.minDstAmount,
      ...(row.auction !== null ? { auction: row.auction as unknown as Intent["auction"] } : {}),
      ...(row.acceptedDstAmount !== null ? { acceptedDstAmount: row.acceptedDstAmount } : {}),
      ...(row.quotedDstAmount !== null ? { quotedDstAmount: row.quotedDstAmount } : {}),
      ...(row.solver !== null ? { solver: row.solver } : {}),
      state: row.state as IntentState,
      createdAt: row.createdAt,
      deadline: row.deadline,
      ...(row.filledAt !== null ? { filledAt: row.filledAt } : {}),
      ...(row.fillAmount !== null ? { fillAmount: row.fillAmount } : {}),
      ...(row.feeAmount !== undefined && row.feeAmount !== null ? { feeAmount: row.feeAmount } : {}),
      ...(row.txHash !== null ? { txHash: row.txHash } : {}),
      ...(row.usdValueAtCreate !== null && row.usdValueAtCreate !== undefined
        ? { usdValueAtCreate: row.usdValueAtCreate }
        : {}),
      ...(row.fillVerificationState ? { fillVerificationState: row.fillVerificationState } : {}),
      ...(row.fillVerificationReason ? { fillVerificationReason: row.fillVerificationReason } : {}),
      ...(row.fillVerifiedAt ? { fillVerifiedAt: row.fillVerifiedAt.toISOString() } : {}),
    };
  }

  private toPrismaState(state: IntentState): PrismaIntentState {
    return state as PrismaIntentState;
  }
}
