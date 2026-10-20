import { SupportedChain } from "../intents/intents.types";

/**
 * Per-fill metrics (issue #417).
 *
 * One immutable row per fill outcome — a solver filling an intent, or
 * failing to (the intent was slashed). Solver statistics are derived from
 * these rows, so they can be recomputed, audited and windowed. Rows are never
 * updated: a slash the slashing saga later cancels gets a compensating
 * `reversed` row (same timestamp as the `failed` row it cancels), and
 * failures count as `failed - reversed`. The mutable
 * `Solver.totalVolume` / `fillsCompleted` / `fillsFailed` counters stay as a
 * compatibility projection only.
 */
export type SolverFillOutcome = "filled" | "failed" | "reversed";

export interface SolverFillRecord {
  intentId: string;
  solver: string;
  /** Source chain of the intent. */
  chain: SupportedChain;
  /** Source amount, base units (decimal string). */
  srcAmount: string;
  /** Delivered destination amount, base units; null for a failed fill. */
  dstAmount: string | null;
  /**
   * USD value snapshotted when the row is written, from the token price
   * oracle at that moment: the delivered destination amount for a fill, the
   * source amount at stake for a failure. Decimal string with 8 fractional
   * digits, or null when no price was known. Never recomputed.
   */
  usdValue: string | null;
  /**
   * Seconds from intent creation to fill — the same definition the
   * pre-existing stats used, so windows line up with history. Null for a
   * failed fill.
   */
  fillSeconds: number | null;
  outcome: SolverFillOutcome;
  /** Stellar ledger of the fill transaction, when known. */
  ledger: number | null;
  /** Unix epoch seconds the outcome was recorded. */
  createdAt: number;
}

/** Stats window accepted by the solver stats and leaderboard endpoints. */
export type FillWindow = "24h" | "7d" | "30d" | "all";

export const FILL_WINDOW_SECONDS: Record<Exclude<FillWindow, "all">, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

/** Inclusive lower bound (unix seconds) for `window`, or undefined for "all". */
export function windowStart(window: FillWindow, now: number): number | undefined {
  return window === "all" ? undefined : now - FILL_WINDOW_SECONDS[window];
}

/** Aggregated statistics for one solver over a window. */
export interface SolverFillAggregate {
  solver: string;
  fillsCompleted: number;
  fillsFailed: number;
  /** Sum of delivered destination amounts, base units. */
  totalVolume: string;
  /** Sum of snapshotted USD values of fills, 8 fractional digits; null when none were priced. */
  totalVolumeUsd: string | null;
  /** Mean fill time in seconds, rounded; 0 with no timed fills. */
  avgFillTime: number;
  /** Nearest-rank median fill time in seconds; null with no timed fills. */
  p50FillTime: number | null;
  /** Nearest-rank 95th-percentile fill time in seconds; null with no timed fills. */
  p95FillTime: number | null;
}

export function emptyAggregate(solver: string): SolverFillAggregate {
  return {
    solver,
    fillsCompleted: 0,
    fillsFailed: 0,
    totalVolume: "0",
    totalVolumeUsd: null,
    avgFillTime: 0,
    p50FillTime: null,
    p95FillTime: null,
  };
}
