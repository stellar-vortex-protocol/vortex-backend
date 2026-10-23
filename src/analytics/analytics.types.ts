/**
 * Shared types for the analytics subsystem.
 *
 * The analytics store is isolated from OLTP writes: fill events are ingested
 * idempotently (keyed by a stable `eventId`) and aggregated into 1m/1h/1d
 * buckets. See docs/adr/0001-analytics-store.md.
 */

export const ANALYTICS_METRICS = [
  "volume",
  "fees",
  "latency",
  "solver-share",
  "token-pair",
  "chain-pair",
  "slippage",
] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export const ANALYTICS_INTERVALS = ["1m", "1h", "1d"] as const;
export type AnalyticsInterval = (typeof ANALYTICS_INTERVALS)[number];

/** A single fill event (the analytics grain). Amounts are bigint base units. */
export interface AnalyticsFillEvent {
  /** Stable idempotency key, e.g. `fill:<intentId>`. */
  eventId: string;
  /** Epoch milliseconds of the fill. */
  timestamp: number;
  /** Source chain id (e.g. "stellar", "ethereum"). */
  chain: string;
  /**
   * Destination chain id. Always "stellar" for new fills; rows recorded before
   * the chain-pair migration read back as "unknown" (no backfill).
   */
  dstChain: string;
  /** Source token symbol. */
  srcToken: string;
  /** Destination token symbol. */
  dstToken: string;
  /** Solver address that filled the intent. */
  solver: string;
  /** Filled destination amount in base units. */
  volume: bigint;
  /** Realized protocol fee in destination-token base units. */
  fees: bigint;
  /** Fill latency in milliseconds (filledAt - createdAt). */
  durationMs: number;
  /**
   * Quoted destination amount at intent creation time (base units).
   * Null when no prior /quote call was made (direct accept without a quote).
   * Excluded from slippage calculations when null.
   */
  quotedDstAmount: bigint | null;
}

/** Query parameters common to every analytics endpoint. */
export interface AnalyticsQuery {
  interval: AnalyticsInterval;
  /** Inclusive lower bound, epoch milliseconds. */
  from: number;
  /** Exclusive upper bound, epoch milliseconds. */
  to: number;
  /** Optional chain filter (matches source chain). */
  chain?: string;
  /** Optional token filter (matches source or destination token symbol). */
  token?: string;
  /** Optional solver filter (exact match on the filling solver's address). */
  solver?: string;
  /** Source-chain filter. Only accepted by the `chain-pair` metric. */
  srcChain?: string;
  /** Destination-chain filter. Only accepted by the `chain-pair` metric. */
  dstChain?: string;
}

export interface VolumePoint {
  /** ISO-8601 bucket start. */
  start: string;
  /** Summed filled volume (base-unit string). */
  volume: string;
}

export interface FeesPoint {
  start: string;
  /** Summed protocol fees (base-unit string). */
  fees: string;
}

export interface LatencyPoint {
  start: string;
  avgMs: number;
  p95Ms: number;
  count: number;
}

export interface SolverSharePoint {
  start: string;
  solver: string;
  /** Solver's filled volume in the bucket (base-unit string). */
  volume: string;
  /** Solver's share of the bucket's total volume, 0..1. */
  share: number;
}

/**
 * Volume and fees for one exact `(srcToken, dstToken)` swap pair in a bucket.
 *
 * Known limitation: token symbols carry no chain qualifier in
 * `AnalyticsFillEvent`, so the same symbol on two chains (e.g. USDC on Stellar
 * and on Ethereum) lands in the same pair. Combine with the `chain` filter to
 * separate them.
 */
export interface TokenPairPoint {
  start: string;
  srcToken: string;
  dstToken: string;
  /** Summed filled volume for the pair (base-unit string). */
  volume: string;
  /** Summed protocol fees for the pair (base-unit string). */
  fees: string;
}

/** One solver's activity in a bucket — the raw input to solver benchmarks. */
export interface PerSolverPoint {
  start: string;
  solver: string;
  /** Mean fill latency for this solver in the bucket, ms (rounded). */
  avgMs: number;
  /** Summed filled volume for this solver (base-unit string). */
  volume: string;
  /** Number of fills by this solver in the bucket. */
  count: number;
}

/**
 * One bucket of `GET /analytics/solver-benchmark/:address`: the solver's own
 * figures next to the median across every active solver in the same bucket.
 * `solver` is `null` when the requested solver had no fills in the bucket.
 */
export interface SolverBenchmarkPoint {
  start: string;
  solver: { avgMs: number; volume: string; count: number } | null;
  protocol: {
    /** Median of each active solver's mean latency, ms. */
    medianAvgMs: number;
    /** Median of each active solver's volume (base-unit string, floored). */
    medianVolume: string;
    /** Number of solvers with at least one fill in the bucket. */
    solverCount: number;
  };
}

/**
 * Cross-chain corridor volume per bucket.
 * Pre-migration fills with no dstChain recorded will appear as srcChain→"unknown".
 */
export interface ChainPairPoint {
  start: string;
  srcChain: string;
  dstChain: string;
  /** Summed filled volume across the corridor in the bucket (base-unit string). */
  volume: string;
}

/**
 * Realized slippage per bucket expressed in basis points (bps).
 * Slippage = (quotedDstAmount - fillAmount) / quotedDstAmount × 10_000.
 * Negative values indicate the fill was *better* than quoted (favorable slippage).
 * Events with a null quotedDstAmount are excluded from the calculation.
 */
export interface SlippagePoint {
  start: string;
  /** Average realized slippage in basis points (can be negative). */
  avgBps: number;
  /** 95th-percentile realized slippage in basis points. */
  p95Bps: number;
  /** Number of fills included in the calculation (null-quote fills excluded). */
  count: number;
  /** Number of fills excluded because they had no quoted amount. */
  excludedCount: number;
}

/** Milliseconds per aggregation bucket for each interval. */
export const INTERVAL_MS: Record<AnalyticsInterval, number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

// ── Grouped (ad-hoc) queries — POST /api/v1/analytics/query ──────────────────

/** Metrics the grouped query builder can aggregate. Both are additive sums. */
export const GROUPED_METRICS = ["volume", "fees"] as const;
export type GroupedMetric = (typeof GROUPED_METRICS)[number];

/**
 * The closed set of dimensions a grouped query may break results down by.
 * This is an allowlist: the SQL backend maps each value to a fixed column name
 * and never interpolates caller-supplied strings into the query.
 *
 * `token` groups by the fill's *source* token symbol, so each fill is counted
 * exactly once (grouping by source and destination would double-count).
 */
export const GROUP_BY_DIMENSIONS = ["chain", "token", "solver"] as const;
export type GroupByDimension = (typeof GROUP_BY_DIMENSIONS)[number];

export interface AnalyticsGroupedQuery extends AnalyticsQuery {
  metric: GroupedMetric;
  /** Dimensions to group by, in addition to the time bucket. May be empty. */
  groupBy: GroupByDimension[];
}

/**
 * One row per bucket × group-by combination. Only the requested dimensions are
 * present, and the aggregate is keyed by the metric name, so an empty
 * `groupBy` yields exactly the `VolumePoint`/`FeesPoint` shape.
 */
export type GroupedPoint = { start: string } & Partial<Record<GroupByDimension, string>> &
  Partial<Record<GroupedMetric, string>>;

/**
 * De-duplicate and order dimensions canonically (chain, token, solver) so the
 * same request always yields the same columns and row order.
 */
export function normalizeGroupBy(groupBy: readonly string[]): GroupByDimension[] {
  for (const dim of groupBy) {
    if (!(GROUP_BY_DIMENSIONS as readonly string[]).includes(dim)) {
      throw new Error(`Unsupported group-by dimension "${dim}"`);
    }
  }
  return GROUP_BY_DIMENSIONS.filter((d) => groupBy.includes(d));
}
