/**
 * Archived price snapshots for USD valuation during replay (issue #452).
 *
 * Prices arrive as JSONL rows (`{"ts","chain","symbol","priceUsd","decimals?"}`)
 * and are looked up as-of a simulated timestamp: the latest snapshot at or
 * before `ts`. Unknown pairs/timestamps return `null` — the harness never
 * fabricates a price, mirroring `usdValueAtCreate` semantics in
 * `src/intents/intents.types.ts`.
 */

/** One price snapshot row from the archive. */
export interface PriceRow {
  /** Unix epoch seconds. */
  ts: number;
  chain: string;
  symbol: string;
  priceUsd: number;
  /** Token decimals for base-unit conversion; defaults per chain. */
  decimals?: number;
}

/** A resolved price point. */
export interface PricePoint {
  priceUsd: number;
  decimals: number;
}

function defaultDecimals(chain: string): number {
  return chain === "stellar" ? 7 : 18;
}

/**
 * Immutable, time-indexed price store.
 *
 * Rows are bucketed per `chain:symbol` and sorted once at construction;
 * lookups binary-search the bucket, keeping replays O(log n) per valuation.
 */
export class PriceBook {
  private readonly buckets = new Map<string, PriceRow[]>();

  constructor(rows: readonly PriceRow[] = []) {
    for (const row of rows) {
      const key = `${row.chain}:${row.symbol}`;
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(row);
      else this.buckets.set(key, [row]);
    }
    for (const bucket of this.buckets.values()) {
      bucket.sort((a, b) => a.ts - b.ts);
    }
  }

  /** Latest snapshot at or before `ts`, or null when the pair is unknown. */
  lookup(chain: string, symbol: string, ts: number): PricePoint | null {
    const bucket = this.buckets.get(`${chain}:${symbol}`);
    if (!bucket || bucket.length === 0) return null;
    // Binary search for the last row with row.ts <= ts.
    let lo = 0;
    let hi = bucket.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bucket[mid].ts <= ts) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 0) return null;
    const row = bucket[best];
    return { priceUsd: row.priceUsd, decimals: row.decimals ?? defaultDecimals(chain) };
  }

  /**
   * USD value of `amountBase` base units at `ts`.
   *
   * Returns null when no snapshot exists — callers must treat unknown
   * economics as "cannot evaluate", never as zero.
   */
  usdValue(chain: string, symbol: string, amountBase: string, ts: number): number | null {
    const point = this.lookup(chain, symbol, ts);
    if (!point) return null;
    const amount = Number(amountBase);
    if (!Number.isFinite(amount)) return null;
    return (amount / 10 ** point.decimals) * point.priceUsd;
  }
}
