/**
 * Types for the shadow-mode divergence monitor (issue #401).
 *
 * The monitor runs on-chain *simulations* of every state transition in parallel
 * with the authoritative off-chain path and records where the two disagree.
 * It exists so the on-chain cutover runbook
 * (docs/runbooks/onchain-cutover.md) can quote a quantitative go/no-go
 * threshold ("divergence rate ~ 0 over N days") instead of a vibe.
 *
 * Nothing in this file touches the network — these are pure data shapes shared
 * by the classifier, the queue, the metrics adapter and the report endpoint.
 */

/**
 * The five intent state transitions that the cutover would push on-chain.
 *
 * Kept as a frozen tuple (rather than a bare `string`) so the compiler — and
 * the `@IsIn`/label-set consumers in shadow.service.ts — stay in sync
 * automatically, mirroring how `INTENT_STATES` is derived in
 * `src/intents/intents.types.ts`.
 */
export const SHADOW_TRANSITIONS = ["accept", "fill", "cancel", "expire", "slash"] as const;

export type ShadowTransition = (typeof SHADOW_TRANSITIONS)[number];

/**
 * Why a simulated outcome diverged from the off-chain outcome.
 *
 * - `outcome_mismatch` — both sides ran, but the contract accepted/rejected
 *   differently from what the off-chain path decided. This is the class of bug
 *   the cutover must not ship with.
 * - `simulation_error` — the contract call would have errored (revert, missing
 *   method, panic) even though the off-chain path succeeded.
 * - `simulation_exception` — the simulation itself could not be performed
 *   (RPC unreachable, malformed XDR, transport error). Distinguished from
 *   `simulation_error` so operators can tell "the contract is wrong" apart from
 *   "we could not ask the contract".
 * - `contract_unconfigured` — `SETTLEMENT_CONTRACT_ID` is empty, so there is
 *   nothing to simulate against. Reported separately so an unconfigured
 *   deployment is never silently read as "zero divergence".
 */
export const SHADOW_DIVERGENCE_REASONS = [
  "outcome_mismatch",
  "simulation_error",
  "simulation_exception",
  "contract_unconfigured",
] as const;

export type ShadowDivergenceReason = (typeof SHADOW_DIVERGENCE_REASONS)[number];

/**
 * Coarse outcome shared by the off-chain path and the simulated contract call.
 *
 * - `ok` — the transition was applied / the call would succeed.
 * - `rejected` — the transition was refused by a guard (not open, wrong solver,
 *   below minimum) / the contract's `require!` would reject.
 * - `error` — the operation failed outright.
 */
export type ShadowOutcome = "ok" | "rejected" | "error";

/**
 * A single `(expected_outcome, simulated_outcome)` pair for one transition.
 *
 * This is the unit the issue asks to "record" — it is what feeds both the
 * Prometheus counters and the daily report table.
 */
export interface ShadowObservation {
  transition: ShadowTransition;
  intentId: string;
  /** What the authoritative off-chain path decided. */
  expectedOutcome: ShadowOutcome;
  /** What the on-chain simulation reported, or `null` if it never ran. */
  simulatedOutcome: ShadowOutcome | null;
  /** `null` when the two agree. */
  reason: ShadowDivergenceReason | null;
  /** Short, log-safe explanation. Never contains keys or raw XDR. */
  detail?: string;
  /** ISO-8601 UTC timestamp of when the comparison completed. */
  observedAt: string;
}

/** Aggregated counters for one `(transition, reason)` cell of the divergence table. */
export interface ShadowDivergenceCell {
  transition: ShadowTransition;
  reason: ShadowDivergenceReason;
  count: number;
}

/** Aggregated counters for one transition, regardless of reason. */
export interface ShadowTransitionSummary {
  transition: ShadowTransition;
  compared: number;
  diverged: number;
  /** `diverged / compared`, or 0 when nothing was compared. */
  divergenceRate: number;
}

/** Queue/throughput health, exposed so operators can spot a starved monitor. */
export interface ShadowQueueStats {
  /**
   * Observations currently outstanding: queued plus handed to the simulator
   * but not yet recorded.
   *
   * Both halves matter — a drain splices a batch out of the queue *before* it
   * awaits the RPC, so counting only the queue would read 0 while up to
   * `concurrency` simulations are in flight.
   */
  depth: number;
  /**
   * Effective ceiling on {@link depth}: the configured queue size plus the
   * in-flight batch. Observations beyond it are dropped and counted.
   */
  capacity: number;
  /** Observations dropped because the queue was full. */
  dropped: number;
  /** Observations never queued because sampling skipped them. */
  sampledOut: number;
  /** Observations discarded because the monitor is disabled. */
  disabled: number;
  /** Observations fully processed (compared and recorded). */
  completed: number;
}

/** One UTC calendar day of accumulated counters. */
export interface ShadowDayBucket {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  compared: number;
  diverged: number;
  divergenceRate: number;
  cells: ShadowDivergenceCell[];
}

/**
 * Response body of `GET /api/v1/admin/shadow-report`.
 *
 * Also the shape the daily-summary job (or an operator running curl against
 * staging) reads to decide go/no-go. The threshold it must be compared against
 * is documented in docs/runbooks/onchain-cutover.md.
 *
 * Retention: the monitor is an in-process singleton with no datastore, so
 * counters are lifetime-to-date for the lifetime of the process and the per-day
 * series is capped at `MAX_SHADOW_REPORT_DAYS` buckets. A restart resets the
 * totals; the Prometheus counters are the durable record.
 */
export interface ShadowReport {
  /** Whether the monitor is currently accepting observations. */
  enabled: boolean;
  /** Configured sampling rate in `[0, 1]`. */
  sampleRate: number;
  /** UTC day the report was generated for. */
  day: string;
  /** ISO-8601 timestamp of report generation. */
  generatedAt: string;
  /** Lifetime-to-date comparisons. Not bounded by `days`. */
  compared: number;
  /** Lifetime-to-date divergences. Not bounded by `days`. */
  diverged: number;
  /** `diverged / compared`, or 0 when nothing was compared. */
  divergenceRate: number;
  /** Lifetime-to-date per-transition totals. */
  transitions: ShadowTransitionSummary[];
  /** The divergence table: one row per `(transition, reason)` with a non-zero count. */
  divergences: ShadowDivergenceCell[];
  /** Per-UTC-day breakdown, oldest first, limited to `days`. */
  daily: ShadowDayBucket[];
  /** Queue health. */
  queue: ShadowQueueStats;
}
