import { toCsv } from "../datasets/csv-exporter";
import {
  DatasetRow,
  DatasetSchema,
  SchemaFieldType,
} from "../datasets/datasets.types";
import {
  AnalyticsMetric,
  ChainPairPoint,
  FeesPoint,
  LatencyPoint,
  SlippagePoint,
  SolverSharePoint,
  TokenPairPoint,
  VolumePoint,
} from "./analytics.types";

/**
 * CSV output for `GET /api/v1/analytics/:metric?format=csv` (issue #596).
 *
 * Each metric gets a small, unversioned column list matching its JSON point
 * shape. These are not published dataset contracts, so they live here rather
 * than in the dataset schema registry. Serialisation reuses the dataset
 * pipeline's `toCsv()` unchanged.
 */

type Columns<T> = { [K in keyof Required<T>]: SchemaFieldType };

// Column order is the order of keys below. Base-unit amounts stay strings so
// they reach the CSV exactly as in the JSON response, with no Number() rounding.
const VOLUME: Columns<VolumePoint> = { start: "string", volume: "string" };
const FEES: Columns<FeesPoint> = { start: "string", fees: "string" };
const LATENCY: Columns<LatencyPoint> = {
  start: "string",
  avgMs: "double",
  p95Ms: "double",
  count: "int64",
};
const SOLVER_SHARE: Columns<SolverSharePoint> = {
  start: "string",
  solver: "string",
  volume: "string",
  share: "double",
};
const TOKEN_PAIR: Columns<TokenPairPoint> = {
  start: "string",
  srcToken: "string",
  dstToken: "string",
  volume: "string",
  fees: "string",
};
const CHAIN_PAIR: Columns<ChainPairPoint> = {
  start: "string",
  srcChain: "string",
  dstChain: "string",
  volume: "string",
};
const SLIPPAGE: Columns<SlippagePoint> = {
  start: "string",
  avgBps: "int64",
  p95Bps: "int64",
  count: "int64",
  excludedCount: "int64",
};

const COLUMNS: Record<AnalyticsMetric, Record<string, SchemaFieldType>> = {
  volume: VOLUME,
  fees: FEES,
  latency: LATENCY,
  "solver-share": SOLVER_SHARE,
  "token-pair": TOKEN_PAIR,
  "chain-pair": CHAIN_PAIR,
  slippage: SLIPPAGE,
};

export const ANALYTICS_CSV_FIELDS: Record<AnalyticsMetric, string[]> = Object.fromEntries(
  Object.entries(COLUMNS).map(([metric, cols]) => [metric, Object.keys(cols)]),
) as Record<AnalyticsMetric, string[]>;

/** The ad-hoc schema `toCsv()` needs for a metric. */
export function analyticsCsvSchema(metric: AnalyticsMetric): DatasetSchema {
  return {
    // toCsv() only reads `fields`; `name` is typed for the dataset registry,
    // which these ephemeral analytics schemas are deliberately not part of.
    name: metric as unknown as DatasetSchema["name"],
    version: { major: 0, minor: 0 },
    fields: Object.entries(COLUMNS[metric]).map(([name, type]) => ({
      name,
      type,
    })),
  };
}

/** Serialise a metric's points to CSV, one row per point. */
export function analyticsToCsv(
  metric: AnalyticsMetric,
  points: object[],
): Buffer {
  return toCsv(analyticsCsvSchema(metric), points as DatasetRow[]);
}
