/**
 * Lightweight in-process metrics store.
 *
 * Provides a Counter (monotonically increasing) and a Histogram (duration
 * observations bucketed in milliseconds) without pulling in a full Prometheus
 * client library.  Values are exposed via the static `MetricsRegistry`
 * singleton so any service can read or reset them in tests.
 */

export class Counter {
  private value = 0;

  /** Increment by `amount` (defaults to 1). */
  inc(amount = 1): void {
    this.value += amount;
  }

  /** Return the current total. */
  get(): number {
    return this.value;
  }

  /** Reset to zero (useful in tests). */
  reset(): void {
    this.value = 0;
  }
}

export class Histogram {
  /** Upper-bound bucket edges in milliseconds. */
  static readonly DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

  private readonly buckets: Map<number, number>;
  private sum = 0;
  private count = 0;

  constructor(bucketEdges: number[] = Histogram.DEFAULT_BUCKETS) {
    this.buckets = new Map(bucketEdges.sort((a, b) => a - b).map((b) => [b, 0]));
  }

  /** Record one observation (milliseconds). */
  observe(ms: number): void {
    this.sum += ms;
    this.count += 1;
    for (const edge of this.buckets.keys()) {
      if (ms <= edge) {
        this.buckets.set(edge, (this.buckets.get(edge) ?? 0) + 1);
      }
    }
  }

  getCount(): number {
    return this.count;
  }

  getSum(): number {
    return this.sum;
  }

  /** Return a snapshot: { buckets, sum, count }. */
  snapshot(): { buckets: Record<string, number>; sum: number; count: number } {
    const buckets: Record<string, number> = {};
    for (const [edge, cnt] of this.buckets) {
      buckets[`le_${edge}`] = cnt;
    }
    return { buckets, sum: this.sum, count: this.count };
  }

  /** Reset all observations (useful in tests). */
  reset(): void {
    this.sum = 0;
    this.count = 0;
    for (const edge of this.buckets.keys()) {
      this.buckets.set(edge, 0);
    }
  }
}

/** Singleton registry — import and use from any module. */
export const MetricsRegistry = {
  sweeper: {
    /** Total number of intents expired across all sweeps. */
    expiredTotal: new Counter(),
    /** Duration (ms) of each sweep() execution. */
    sweepDurationMs: new Histogram(),
  },
} as const;
