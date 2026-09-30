/**
 * Pure divergence-classification helpers for the shadow-mode monitor
 * (issue #401).
 *
 * Kept free of NestJS, timers and network I/O so the classification rules can
 * be exhaustively unit-tested and so the request path only ever pays for a
 * function call — the expensive part (RPC simulation) happens later, on a
 * background drain of the bounded queue.
 */

import {
  SHADOW_DIVERGENCE_REASONS,
  SHADOW_TRANSITIONS,
  type ShadowDivergenceReason,
  type ShadowOutcome,
  type ShadowTransition,
} from "./shadow.types";

/**
 * Minimal structural shape of a `SorobanRpc.Api.SimulateTransactionResponse`
 * that the classifier needs.
 *
 * Declared structurally (rather than importing the SDK type) so unit tests can
 * build fixtures without constructing full XDR envelopes, and so this module
 * has no compile-time coupling to the SDK's generated typings.
 */
export interface SimulationLikeResponse {
  error?: string;
  result?: unknown;
}

/**
 * Result of asking the contract what it *would* do.
 *
 * `outcome` is the simulated side of the `(expected, simulated)` pair;
 * `threw` distinguishes "the contract answered with an error" from "we never
 * got an answer" so the two map to different divergence reasons.
 */
export interface SimulationClassification {
  outcome: ShadowOutcome;
  /** True when the simulation could not be performed at all. */
  threw: boolean;
  /** Log-safe detail string, truncated for safe logging. */
  detail?: string;
}

/** Cap on `detail` so a hostile/misbehaving RPC can't flood the logs. */
const MAX_DETAIL_LENGTH = 200;

/** Truncate and strip control characters so a detail string is always log-safe. */
function sanitizeDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : cleaned;
}

/**
 * Narrow an arbitrary value to a {@link ShadowTransition}, or `null`.
 *
 * Used at the single point where an observation is recorded so a typo in a
 * transition label can never create an unbounded metric-cardinality leak.
 */
export function asShadowTransition(value: string): ShadowTransition | null {
  return (SHADOW_TRANSITIONS as readonly string[]).includes(value)
    ? (value as ShadowTransition)
    : null;
}

/**
 * Narrow an arbitrary value to a {@link ShadowDivergenceReason}, or `null`.
 */
export function asShadowDivergenceReason(value: string): ShadowDivergenceReason | null {
  return (SHADOW_DIVERGENCE_REASONS as readonly string[]).includes(value)
    ? (value as ShadowDivergenceReason)
    : null;
}

/**
 * Derive the outcome the *off-chain* path expects the contract to produce.
 *
 * The off-chain path is authoritative today, so a committed transition implies
 * the contract must agree it was a success. `committed: false` means a guard
 * (already-accepted, wrong solver, below minimum) stopped the transition before
 * it was written — those are recorded as `rejected` so a contract that would
 * have *accepted* the operation is flagged rather than assumed benign.
 */
export function expectedOutcomeFromOffchain(committed: boolean): ShadowOutcome {
  return committed ? "ok" : "rejected";
}

/**
 * Substrings that identify a *contract-level refusal* in a Soroban simulation
 * error string, as opposed to a hard failure (panicking VM, missing export,
 * RPC-level problem).
 *
 * When a contract's `require!` guard trips, the host reports the revert through
 * the error channel rather than as a distinct status. Recognising it lets the
 * monitor say "the contract rejected this transition" (`rejected`) instead of
 * the much less actionable "the simulation errored" (`error`) — which is the
 * difference between a guard that disagrees with the off-chain path and a
 * contract that cannot be called at all.
 *
 * Kept as a lowercase, dependency-free substring list so the rule is trivially
 * testable and cheap to run on every drained queue item.
 */
const CONTRACT_REVERT_MARKERS: readonly string[] = [
  "error(contract",
  "error(wasmvm",
  "reverted",
  "revert",
];

/**
 * Markers that identify a *hard* failure: the contract was never executed, so
 * no verdict about it can be reached.
 *
 * Checked before {@link CONTRACT_REVERT_MARKERS} because a host error string
 * can carry both — `HostError: Error(WasmVm, InvalidAction) missing export`
 * names a WasmVm error *and* proves the module could not be loaded. The
 * missing export is the more specific fact: calling it a contract rejection
 * would blame the contract for a deployment problem.
 */
const HARD_FAILURE_MARKERS: readonly string[] = ["missing export"];

/**
 * True when a simulation error string looks like a contract-level guard
 * failure rather than a hard error.
 */
export function isContractRevert(detail: string | undefined): boolean {
  if (!detail) return false;
  const lower = detail.toLowerCase();
  if (HARD_FAILURE_MARKERS.some((marker) => lower.includes(marker))) return false;
  return CONTRACT_REVERT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Map a `simulateTransaction` response onto a {@link SimulationClassification}.
 *
 * - No response at all → the call never produced a verdict: `threw: true`.
 * - An `error` member that looks like a contract guard failure → `rejected`
 *   with `threw: false`. The contract was reached and said no.
 * - Any other `error` member → `error` with `threw: false`. The contract could
 *   not produce a usable verdict.
 * - No `error` member → `ok`.
 */
export function classifySimulationResponse(
  response: SimulationLikeResponse | null | undefined,
): SimulationClassification {
  if (!response) {
    return { outcome: "error", threw: true, detail: "empty simulation response" };
  }
  const rawError = response.error;
  if (rawError !== undefined && rawError !== null && rawError !== "") {
    const detail = sanitizeDetail(rawError);
    // Match the marker against the *unsanitized* string: a long RPC error can
    // carry its revert marker well past the truncation point, and truncating
    // before the check would silently reclassify a guard failure as a hard
    // error.
    return isContractRevert(rawError)
      ? { outcome: "rejected", threw: false, ...(detail ? { detail } : {}) }
      : { outcome: "error", threw: false, ...(detail ? { detail } : {}) };
  }
  return { outcome: "ok", threw: false };
}

/**
 * Classify a thrown value from the simulation call.
 *
 * A thrown error means we never obtained a verdict, so `threw: true` maps to
 * `simulation_exception` rather than `simulation_error` in
 * {@link classifyDivergence}. This distinction is the whole point: an operator
 * reading the report must be able to tell "the contract disagrees with us"
 * apart from "we could not ask the contract".
 */
export function classifySimulationFailure(err: unknown): SimulationClassification {
  const message = err instanceof Error ? err.message : String(err);
  return { outcome: "error", threw: true, detail: sanitizeDetail(message) ?? "unknown error" };
}

/**
 * Decide whether a `(expected, simulated)` pair diverges, and why.
 *
 * Rules, in order:
 * 1. `simulated === null` — the simulation never ran. Divergence only if the
 *    expected side is `ok` (an unconfigured contract cannot honour a real
 *    transition); reason is `contract_unconfigured`.
 * 2. `simulated.threw` — we could not get a verdict. Reason is
 *    `simulation_exception`.
 * 3. `simulated.outcome === "error"` and expected is `ok` — the contract would
 *    have failed where the off-chain path succeeded. Reason is
 *    `simulation_error`.
 * 4. `expected === simulated.outcome` — agreement, no divergence.
 * 5. Anything else (ok vs rejected, rejected vs ok, error vs rejected) — the
 *    contract and the off-chain path reached different verdicts. Reason is
 *    `outcome_mismatch`.
 *
 * An `expected: "error"` observation is never a divergence: the off-chain path
 * failing is a known condition, and flagging the contract for agreeing about
 * a failure we already have would be noise.
 */
export function classifyDivergence(
  expected: ShadowOutcome,
  simulated: SimulationClassification | null,
): ShadowDivergenceReason | null {
  if (simulated === null) {
    return expected === "ok" ? "contract_unconfigured" : null;
  }
  if (simulated.threw) {
    return "simulation_exception";
  }
  if (simulated.outcome === "error") {
    return expected === "ok" ? "simulation_error" : null;
  }
  if (expected === simulated.outcome) {
    return null;
  }
  return "outcome_mismatch";
}
