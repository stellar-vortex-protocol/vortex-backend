/**
 * Shared decision gate for strategies — and the exact accept gate the live
 * reference bot runs (issue #452).
 *
 * `scripts/solver-bot.ts` imports {@link attemptGateReason} so the live
 * bot and the `always-fill` reference strategy literally share one
 * decision path: whatever passes here passes in a replay, and vice versa.
 */
import type { ArchivedIntent } from "../types";

/** Why a gate declined an intent; `null` means "attempt it". */
export type GateReason = "state" | "deadline" | "chain" | "margin";

/** Inputs to {@link attemptGateReason}. */
export interface AttemptGate {
  /** Chains the solver trades. */
  chains: readonly string[];
  /** Minimum margin in bps using the bot's absolute-base-unit heuristic. */
  minMarginBps: number;
  /** Current time (simulated clock in replay, wall clock in the bot). */
  nowSec: number;
  /**
   * Skip the `state === "open"` check. Replay rows describe the creation
   * moment (or carry the intent's final state when exported from the
   * public dataset), so strategies ignore state while the live bot — which
   * sees real state transitions — does not.
   */
  ignoreState?: boolean;
}

/**
 * Evaluate the shared accept gate.
 *
 * Precedence matches the reference bot: state, deadline, chain, margin.
 *
 * @param intent Intent (or bot-local view of one) to evaluate.
 * @param gate   Gate inputs.
 * @returns The decline reason, or `null` when the intent should be attempted.
 */
export function attemptGateReason(
  intent: Pick<ArchivedIntent, "state" | "deadline" | "srcChain" | "minDstAmount">,
  gate: AttemptGate,
): GateReason | null {
  if (!gate.ignoreState && intent.state !== undefined && intent.state !== "open") return "state";
  if (intent.deadline <= gate.nowSec) return "deadline";
  if (!gate.chains.includes(intent.srcChain)) return "chain";
  if (gate.minMarginBps > 0 && Number(intent.minDstAmount) < 1_000_000 * (gate.minMarginBps / 10_000)) {
    return "margin";
  }
  return null;
}

/**
 * The moment after which a fill for `intent` is late under the current
 * fill-window parameter: the intent deadline, tightened to
 * `createdAt + fillWindowSec` when a window is configured.
 *
 * @param intent        Intent being filled.
 * @param fillWindowSec Protocol fill window in seconds; `0` disables it.
 */
export function effectiveDeadline(intent: ArchivedIntent, fillWindowSec: number): number {
  if (fillWindowSec > 0) return Math.min(intent.deadline, intent.createdAt + fillWindowSec);
  return intent.deadline;
}
