/**
 * Shared types for the analytics subsystem.
 *
 * The analytics store is isolated from OLTP writes: fill events are ingested
 * idempotently (keyed by a stable `eventId`) and aggregated into 1m/1h/1d
 * buckets. See docs/adr/0001-analytics-store.md.
 */

export const ANALYTICS_METRICS = ["volume", "fees", "latency", "solver-share"] as const;
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
}

/** Query parameters common to every analytics endpoint. */
export interface AnalyticsQuery {
  interval: AnalyticsInterval;
  /** Inclusive lower bound, epoch milliseconds. */
  from: number;
  /** Exclusive upper bound, epoch milliseconds. */
  to: number;
  /** Optional chain filter. */
  chain?: string;
  /** Optional token filter (matches source or destination token symbol). */
  token?: string;
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

/** Milliseconds per aggregation bucket for each interval. */
export const INTERVAL_MS: Record<AnalyticsInterval, number> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};
