import { v4 as uuidv4 } from "uuid";
import type { IntentFill } from "../intents.types";
import { planReservation, proRataMinDst, ReservationRejection } from "./partial-fill.math";

/** Injection token for {@link IIntentFillsRepository}. */
export const INTENT_FILLS_REPOSITORY = Symbol("INTENT_FILLS_REPOSITORY");

export interface ReserveRequest {
  intentId: string;
  /** The intent's terms, read by the caller; the adapter re-validates them under its lock. */
  srcAmount: string;
  minDstAmount: string;
  minFillAmount?: string;
  solver: string;
  amount: string;
  deadline: number;
  now: number;
}

export type ReserveResult =
  | { ok: true; fill: IntentFill }
  | { ok: false; reason: ReservationRejection | "intent_not_open"; remaining: string };

/**
 * Storage for partial-fill tranches (`intent_fills`, issue #427).
 *
 * The one hard requirement is that {@link reserve} is atomic per intent: two
 * solvers reserving concurrently must never together exceed `srcAmount`. The
 * in-memory adapter serialises per intent with a promise chain; the Prisma
 * adapter takes a row lock on the parent intent (`SELECT … FOR UPDATE`) so the
 * check and the insert happen inside one transaction.
 *
 * Status changes are conditional writes (`WHERE status = 'reserved' …`) so a
 * fill racing the sweeper's slash has exactly one winner.
 */
export interface IIntentFillsRepository {
  /**
   * Reserve a tranche if the plan allows it. `isOpen` is re-evaluated under
   * the lock so a concurrent settle / cancel / expiry wins cleanly.
   */
  reserve(request: ReserveRequest, isOpen: () => Promise<boolean> | boolean): Promise<ReserveResult>;
  findById(fillId: string): Promise<IntentFill | undefined>;
  listByIntent(intentId: string): Promise<IntentFill[]>;
  /** Intent ids with at least one tranche (any status). */
  intentIdsWithFills(intentIds: readonly string[]): Promise<Set<string>>;
  /** Live reservations whose deadline has passed. */
  findExpiredReservations(now: number, limit?: number): Promise<IntentFill[]>;
  /** reserved → filled, only for `solver`, only before the tranche deadline. */
  markFilled(
    fillId: string,
    solver: string,
    patch: { dstAmount: string; feeAmount: string; txHash?: string; filledAt: number },
  ): Promise<IntentFill | null>;
  /** reserved → slashed, only once the deadline has passed. */
  markSlashed(fillId: string, now: number): Promise<IntentFill | null>;
  /** reserved → released (no penalty). */
  markReleased(fillId: string, now: number): Promise<IntentFill | null>;
}

/** Build the row for a planned reservation — shared by both adapters. */
export function newFillRow(request: ReserveRequest): IntentFill {
  return {
    fillId: uuidv4(),
    intentId: request.intentId,
    solver: request.solver,
    reservedAmount: BigInt(request.amount).toString(),
    minDstAmount: proRataMinDst(request.minDstAmount, request.amount, request.srcAmount),
    status: "reserved",
    reservedAt: request.now,
    deadline: request.deadline,
  };
}

/**
 * Process-local adapter. Per-intent operations are chained on a promise so
 * the read-plan-insert in {@link reserve} cannot interleave, even across
 * `await`s in `isOpen`.
 */
export class InMemoryIntentFillsRepository implements IIntentFillsRepository {
  private readonly fills = new Map<string, IntentFill>();
  private readonly byIntent = new Map<string, string[]>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async reserve(request: ReserveRequest, isOpen: () => Promise<boolean> | boolean): Promise<ReserveResult> {
    return this.withLock(request.intentId, async () => {
      const current = this.listSync(request.intentId);
      if (!(await isOpen())) {
        return { ok: false as const, reason: "intent_not_open" as const, remaining: "0" };
      }
      const plan = planReservation({
        srcAmount: request.srcAmount,
        minFillAmount: request.minFillAmount,
        fills: current,
        amount: request.amount,
      });
      if (!plan.ok) return { ok: false as const, reason: plan.reason, remaining: plan.remaining.toString() };
      const fill = newFillRow(request);
      this.fills.set(fill.fillId, fill);
      this.byIntent.set(request.intentId, [...(this.byIntent.get(request.intentId) ?? []), fill.fillId]);
      return { ok: true as const, fill: { ...fill } };
    });
  }

  async findById(fillId: string): Promise<IntentFill | undefined> {
    const fill = this.fills.get(fillId);
    return fill ? { ...fill } : undefined;
  }

  async listByIntent(intentId: string): Promise<IntentFill[]> {
    return this.listSync(intentId).map((f) => ({ ...f }));
  }

  async intentIdsWithFills(intentIds: readonly string[]): Promise<Set<string>> {
    return new Set(intentIds.filter((id) => (this.byIntent.get(id)?.length ?? 0) > 0));
  }

  async findExpiredReservations(now: number, limit = 500): Promise<IntentFill[]> {
    const out: IntentFill[] = [];
    for (const fill of this.fills.values()) {
      if (fill.status === "reserved" && fill.deadline <= now) out.push({ ...fill });
      if (out.length >= limit) break;
    }
    return out;
  }

  async markFilled(
    fillId: string,
    solver: string,
    patch: { dstAmount: string; feeAmount: string; txHash?: string; filledAt: number },
  ): Promise<IntentFill | null> {
    const fill = this.fills.get(fillId);
    if (!fill) return null;
    return this.withLock(fill.intentId, async () => {
      const current = this.fills.get(fillId)!;
      if (current.status !== "reserved" || current.solver !== solver || current.deadline <= patch.filledAt) return null;
      const updated: IntentFill = { ...current, status: "filled", ...patch };
      this.fills.set(fillId, updated);
      return { ...updated };
    });
  }

  async markSlashed(fillId: string, now: number): Promise<IntentFill | null> {
    return this.transition(fillId, (f) => f.status === "reserved" && f.deadline <= now, { status: "slashed", slashedAt: now });
  }

  async markReleased(fillId: string, now: number): Promise<IntentFill | null> {
    return this.transition(fillId, (f) => f.status === "reserved", { status: "released", releasedAt: now });
  }

  private async transition(
    fillId: string,
    guard: (fill: IntentFill) => boolean,
    patch: Partial<IntentFill>,
  ): Promise<IntentFill | null> {
    const fill = this.fills.get(fillId);
    if (!fill) return null;
    return this.withLock(fill.intentId, async () => {
      const current = this.fills.get(fillId)!;
      if (!guard(current)) return null;
      const updated = { ...current, ...patch };
      this.fills.set(fillId, updated);
      return { ...updated };
    });
  }

  private listSync(intentId: string): IntentFill[] {
    return (this.byIntent.get(intentId) ?? []).map((id) => this.fills.get(id)!).filter(Boolean);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => gate);
    this.locks.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }
}
