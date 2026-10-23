import { toCsv } from "../datasets/csv-exporter";
import { DatasetRow, DatasetSchema } from "../datasets/datasets.types";
import { AnalyticsMetric } from "./analytics.types";

/**
 * CSV columns for each analytics response type, in the same order as the JSON
 * fields. These are ephemeral response shapes, not versioned dataset
 * contracts, so they live here rather than in the dataset schema registry.
 */
export const ANALYTICS_CSV_FIELDS: Record<AnalyticsMetric, string[]> = {
  volume: ["start", "volume"],
  fees: ["start", "fees"],
  latency: ["start", "avgMs", "p95Ms", "count"],
  "solver-share": ["start", "solver", "volume", "share"],
  "token-pair": ["start", "srcToken", "dstToken", "volume", "fees"],
};

/**
 * Serialise analytics points to CSV with the dataset exporter's `toCsv()`.
 * Base-unit amounts are already strings, so they are written verbatim (no
 * Number() round trip that could lose precision).
 */
export function analyticsToCsv(metric: AnalyticsMetric, points: object[]): string {
  // toCsv only reads the field list; `name`/`version` are placeholders because
  // this is an ad-hoc response shape, not a registered dataset.
  const schema = {
    name: metric,
    version: { major: 0, minor: 0 },
    fields: ANALYTICS_CSV_FIELDS[metric].map((name) => ({ name, type: "string" as const })),
  } as unknown as DatasetSchema;
  return toCsv(schema, points as DatasetRow[]).toString("utf8");
}
