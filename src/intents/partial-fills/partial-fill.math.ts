import type { FillProgress, Intent, IntentFill } from "../intents.types";

/**
 * Pure partial-fill accounting (issue #427).
 *
 * Both storage adapters call {@link planReservation} *inside* their lock /
 * transaction against the tranches they just read, so the over-reservation
 * check and the insert are one atomic step. Everything here is integer
 * (bigint) arithmetic on base-unit strings — no floating point anywhere.
 */

/** Tranches that hold part of `srcAmount`: live reservations and completed fills. */
export function isHolding(fill: Pick<IntentFill, "status">): boolean {
  return fill.status === "reserved" || fill.status === "filled";
}

export interface Allocation {
  srcAmount: bigint;
  reserved: bigint;
  filled: bigint;
  /** srcAmount − reserved − filled. Never negative while the invariant holds. */
  remaining: bigint;
}

/** Split `srcAmount` into reserved / filled / remaining for a set of tranches. */
export function allocation(srcAmount: string, fills: readonly IntentFill[]): Allocation {
  const total = BigInt(srcAmount);
  let reserved = 0n;
  let filled = 0n;
  for (const fill of fills) {
    if (fill.status === "reserved") reserved += BigInt(fill.reservedAmount);
    else if (fill.status === "filled") filled += BigInt(fill.reservedAmount);
  }
  return { srcAmount: total, reserved, filled, remaining: total - reserved - filled };
}

export type ReservationRejection =
  | "invalid_amount"
  | "nothing_remaining"
  | "exceeds_remaining"
  | "below_min_fill";

export type ReservationPlan =
  | { ok: true; remainingAfter: bigint }
  | { ok: false; reason: ReservationRejection; remaining: bigint };

/**
 * Decide whether `amount` may be reserved given the existing tranches.
 *
 * Rules:
 *  - `amount` must be a positive integer;
 *  - it may not exceed what is neither reserved nor filled — an overshoot is
 *    rejected, never silently clipped, so the solver knows exactly what it holds;
 *  - it must be ≥ `minFillAmount`, *unless* it takes the whole remainder. That
 *    exception is what clears rounding dust: a remainder smaller than the
 *    minimum can still be taken in one final tranche instead of being
 *    stranded forever.
 */
export function planReservation(params: {
  srcAmount: string;
  minFillAmount: string | undefined;
  fills: readonly IntentFill[];
  amount: string;
}): ReservationPlan {
  const { remaining } = allocation(params.srcAmount, params.fills);
  let amount: bigint;
  try {
    amount = BigInt(params.amount);
  } catch {
    return { ok: false, reason: "invalid_amount", remaining };
  }
  if (amount <= 0n) return { ok: false, reason: "invalid_amount", remaining };
  if (remaining <= 0n) return { ok: false, reason: "nothing_remaining", remaining };
  if (amount > remaining) return { ok: false, reason: "exceeds_remaining", remaining };
  const min = BigInt(params.minFillAmount ?? "1");
  if (amount < min && amount !== remaining) return { ok: false, reason: "below_min_fill", remaining };
  return { ok: true, remainingAfter: remaining - amount };
}

/**
 * Minimum destination amount a tranche must deliver: its pro-rata share of
 * the intent's `minDstAmount`, rounded **up**. Rounding up means the sum over
 * all tranches is never below `minDstAmount` — the user is never short-changed
 * by dust; at most each tranche over-delivers by one base unit.
 */
export function proRataMinDst(minDstAmount: string, reservedAmount: string, srcAmount: string): string {
  const min = BigInt(minDstAmount);
  const part = BigInt(reservedAmount);
  const total = BigInt(srcAmount);
  if (total === 0n) return "0";
  return ((min * part + total - 1n) / total).toString();
}

/** Aggregate progress for `Intent.fillProgress`. */
export function computeFillProgress(intent: Pick<Intent, "srcAmount" | "state">, fills: readonly IntentFill[]): FillProgress {
  const alloc = allocation(intent.srcAmount, fills);
  let dstFilled = 0n;
  let fillCount = 0;
  let activeReservations = 0;
  for (const fill of fills) {
    if (fill.status === "filled") {
      fillCount += 1;
      dstFilled += BigInt(fill.dstAmount ?? "0");
    } else if (fill.status === "reserved") {
      activeReservations += 1;
    }
  }
  const status: FillProgress["status"] =
    alloc.filled === 0n ? "none" : alloc.filled >= alloc.srcAmount ? "filled" : "partially_filled";
  const settled = intent.state === "filled" || intent.state === "pending_filled";
  return {
    status,
    srcAmount: alloc.srcAmount.toString(),
    reservedAmount: alloc.reserved.toString(),
    filledAmount: alloc.filled.toString(),
    remainingAmount: alloc.remaining.toString(),
    dstFilledAmount: dstFilled.toString(),
    fillCount,
    activeReservations,
    ...(settled && alloc.filled < alloc.srcAmount && alloc.filled > 0n ? { remainderCancelled: true } : {}),
  };
}
