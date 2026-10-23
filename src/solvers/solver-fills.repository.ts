import { SolverFillAggregate, SolverFillRecord, emptyAggregate } from "./solver-fills.types";

/** Injection token for {@link ISolverFillsRepository}. */
export const SOLVER_FILLS_REPOSITORY = Symbol("SOLVER_FILLS_REPOSITORY");

/** Write side, handed to a fill/failure transition's unit of work. */
export interface ISolverFillsWriter {
  /**
   * Append one outcome row. Idempotent on (intentId, outcome): a replayed
   * transition never double-counts.
   */
  record(fill: SolverFillRecord): Promise<void>;
}

export interface FillAggregateQuery {
  /** Restrict to one solver. */
  solver?: string;
  /** Inclusive lower bound on `createdAt` (unix seconds). */
  since?: number;
}

/** Storage contract for per-fill rows (issue #417). */
export interface ISolverFillsRepository extends ISolverFillsWriter {
  /** One aggregate per solver that has at least one row matching `query`. */
  aggregate(query: FillAggregateQuery): Promise<SolverFillAggregate[]>;
  /** Every row for `solver`, oldest first (audit / recomputation). */
  findBySolver(solver: string): Promise<SolverFillRecord[]>;
}

/**
 * Nearest-rank percentile of an ascending-sorted list — the value at
 * 1-based rank ceil(p·n). Matches Postgres `percentile_disc`, so the
 * in-memory and SQL adapters agree exactly.
 */
export function percentileNearestRank(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  // The epsilon keeps e.g. 0.95 * 20 = 19.000000000000004 at rank 19.
  const rank = Math.max(1, Math.ceil(p * sortedAsc.length - 1e-9));
  return sortedAsc[Math.min(rank, sortedAsc.length) - 1];
}

/** Scale used for USD values: 8 fractional digits, as numeric(38, 8). */
const USD_SCALE = 8;

/** Parse an 8-decimal USD string into integer 1e-8 units. */
export function usdToUnits(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole || "0") * 10n ** BigInt(USD_SCALE) + BigInt((frac + "0".repeat(USD_SCALE)).slice(0, USD_SCALE) || "0");
  return negative ? -units : units;
}

/** Format integer 1e-8 units as an 8-decimal USD string. */
export function unitsToUsd(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(USD_SCALE);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(USD_SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * USD value of `amount` base units at `priceUsd`, as an 8-decimal string.
 * Integer arithmetic throughout (price scaled to 1e-8), truncating toward
 * zero. Returns null for an unknown/zero price or a non-integer amount.
 */
export function usdValueOf(amount: string, decimals: number, priceUsd: number | undefined | null): string | null {
  if (priceUsd === undefined || priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) return null;
  const priceUnits = BigInt(Math.round(priceUsd * 10 ** USD_SCALE));
  return unitsToUsd((BigInt(amount) * priceUnits) / 10n ** BigInt(decimals));
}

/**
 * Reference aggregation over in-memory rows. The SQL adapter reproduces it
 * with one GROUP BY query; parity is pinned by `solver-fills.repository.spec`.
 */
export function aggregateFills(rows: SolverFillRecord[], query: FillAggregateQuery = {}): SolverFillAggregate[] {
  const bySolver = new Map<string, SolverFillRecord[]>();
  for (const row of rows) {
    if (query.solver !== undefined && row.solver !== query.solver) continue;
    if (query.since !== undefined && row.createdAt < query.since) continue;
    const list = bySolver.get(row.solver) ?? [];
    list.push(row);
    bySolver.set(row.solver, list);
  }

  const result: SolverFillAggregate[] = [];
  for (const [solver, list] of bySolver) {
    const agg = emptyAggregate(solver);
    let volume = 0n;
    let usd = 0n;
    let priced = false;
    const times: number[] = [];
    let failed = 0;
    let reversed = 0;
    for (const row of list) {
      if (row.outcome === "failed") {
        failed += 1;
        continue;
      }
      if (row.outcome === "reversed") {
        reversed += 1;
        continue;
      }
      agg.fillsCompleted += 1;
      volume += BigInt(row.dstAmount ?? "0");
      if (row.usdValue !== null) {
        usd += usdToUnits(row.usdValue);
        priced = true;
      }
      if (row.fillSeconds !== null) times.push(row.fillSeconds);
    }
    times.sort((a, b) => a - b);
    agg.fillsFailed = Math.max(failed - reversed, 0);
    agg.totalVolume = volume.toString();
    agg.totalVolumeUsd = priced ? unitsToUsd(usd) : null;
    agg.avgFillTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    agg.p50FillTime = percentileNearestRank(times, 0.5);
    agg.p95FillTime = percentileNearestRank(times, 0.95);
    result.push(agg);
  }
  return result.sort((a, b) => (a.solver < b.solver ? -1 : a.solver > b.solver ? 1 : 0));
}

/** In-memory adapter (dev/test, INTENTS_PERSISTENCE=memory). */
export class InMemorySolverFillsRepository implements ISolverFillsRepository {
  private readonly rows: SolverFillRecord[] = [];
  private readonly keys = new Set<string>();

  async record(fill: SolverFillRecord): Promise<void> {
    const key = `${fill.intentId}|${fill.outcome}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.rows.push({ ...fill });
  }

  async aggregate(query: FillAggregateQuery): Promise<SolverFillAggregate[]> {
    return aggregateFills(this.rows, query);
  }

  async findBySolver(solver: string): Promise<SolverFillRecord[]> {
    return this.rows.filter((r) => r.solver === solver).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Every stored row (tests, backfill verification). */
  all(): SolverFillRecord[] {
    return [...this.rows];
  }
}
