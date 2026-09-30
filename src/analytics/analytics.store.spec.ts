import { InMemoryAnalyticsStore, percentile } from "./analytics.store";
import { AnalyticsFillEvent, AnalyticsQuery } from "./analytics.types";

function evt(overrides: Partial<AnalyticsFillEvent> = {}): AnalyticsFillEvent {
  return {
    eventId: "fill:1",
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    chain: "stellar",
    srcToken: "USDC",
    dstToken: "USDC",
    solver: "SOLVER_A",
    volume: 1000n,
    fees: 10n,
    durationMs: 300,
    ...overrides,
  };
}

const q = (overrides: Partial<AnalyticsQuery> = {}): AnalyticsQuery => ({
  interval: "1h",
  from: Date.UTC(2026, 0, 1, 0, 0, 0),
  to: Date.UTC(2026, 0, 2, 0, 0, 0),
  ...overrides,
});

describe("InMemoryAnalyticsStore", () => {
  describe("ingest (idempotency)", () => {
    it("deduplicates events by eventId and returns the newly-inserted count", async () => {
      const store = new InMemoryAnalyticsStore();
      const first = await store.ingest([evt({ eventId: "fill:1" }), evt({ eventId: "fill:2" })]);
      const second = await store.ingest([evt({ eventId: "fill:1" }), evt({ eventId: "fill:2" })]);
      expect(first).toBe(2);
      expect(second).toBe(0);
    });
  });

  describe("queryVolume", () => {
    it("sums volume per bucket and sorts by time", async () => {
      const store = new InMemoryAnalyticsStore();
      await store.ingest([
        evt({ eventId: "a", timestamp: Date.UTC(2026, 0, 1, 1, 0, 0), volume: 100n }),
        evt({ eventId: "b", timestamp: Date.UTC(2026, 0, 1, 1, 30, 0), volume: 200n }),
        evt({ eventId: "c", timestamp: Date.UTC(2026, 0, 1, 2, 0, 0), volume: 500n }),
      ]);

      const points = await store.queryVolume(q());
      expect(points).toHaveLength(2);
      expect(points[0].volume).toBe("300"); // 01:00 bucket
      expect(points[1].volume).toBe("500"); // 02:00 bucket
    });

    it("filters by chain and token", async () => {
      const store = new InMemoryAnalyticsStore();
      await store.ingest([
        evt({ eventId: "a", chain: "stellar", srcToken: "USDC", volume: 100n }),
        evt({ eventId: "b", chain: "ethereum", srcToken: "USDC", volume: 200n }),
        evt({ eventId: "c", chain: "stellar", srcToken: "XLM", volume: 400n }),
      ]);

      const chainOnly = await store.queryVolume(q({ chain: "stellar" }));
      expect(chainOnly.reduce((s, p) => s + BigInt(p.volume), 0n)).toBe(500n);

      const tokenOnly = await store.queryVolume(q({ token: "XLM" }));
      expect(tokenOnly.reduce((s, p) => s + BigInt(p.volume), 0n)).toBe(400n);
    });

    it("respects the [from, to) time range", async () => {
      const store = new InMemoryAnalyticsStore();
      await store.ingest([
        evt({ eventId: "a", timestamp: Date.UTC(2025, 11, 31, 23, 0, 0), volume: 1n }),
        evt({ eventId: "b", timestamp: Date.UTC(2026, 0, 1, 12, 0, 0), volume: 10n }),
        evt({ eventId: "c", timestamp: Date.UTC(2026, 0, 2, 0, 0, 0), volume: 100n }),
      ]);

      const points = await store.queryVolume(q());
      expect(points).toHaveLength(1);
      expect(points[0].volume).toBe("10");
    });
  });

  describe("queryFees", () => {
    it("sums fees per bucket", async () => {
      const store = new InMemoryAnalyticsStore();
      await store.ingest([
        evt({ eventId: "a", timestamp: Date.UTC(2026, 0, 1, 1, 0, 0), fees: 5n }),
        evt({ eventId: "b", timestamp: Date.UTC(2026, 0, 1, 1, 30, 0), fees: 7n }),
      ]);
      const points = await store.queryFees(q());
      expect(points).toHaveLength(1);
      expect(points[0].fees).toBe("12");
    });
  });

  describe("queryLatency", () => {
    it("computes avg, p95 (nearest-rank), and count", async () => {
      const store = new InMemoryAnalyticsStore();
      const durations = [100, 200, 300, 400, 500];
      await store.ingest(
        durations.map((d, i) =>
          evt({ eventId: `fill:${i}`, timestamp: Date.UTC(2026, 0, 1, 1, i, 0), durationMs: d }),
        ),
      );

      const points = await store.queryLatency(q());
      expect(points).toHaveLength(1);
      expect(points[0].count).toBe(5);
      expect(points[0].avgMs).toBe(300);
      expect(points[0].p95Ms).toBe(500);
    });
  });

  describe("querySolverShare", () => {
    it("computes each solver's volume share within a bucket", async () => {
      const store = new InMemoryAnalyticsStore();
      await store.ingest([
        evt({ eventId: "a", solver: "A", volume: 60n }),
        evt({ eventId: "b", solver: "B", volume: 40n }),
        evt({ eventId: "c", solver: "A", volume: 0n }),
      ]);

      const points = await store.querySolverShare(q());
      const bySolver = new Map(points.map((p) => [p.solver, p.share]));
      expect(bySolver.get("A")).toBeCloseTo(0.6);
      expect(bySolver.get("B")).toBeCloseTo(0.4);
    });
  });

  describe("percentile", () => {
    it("returns 0 for empty input and clamps for short input", () => {
      expect(percentile([], 0.95)).toBe(0);
      expect(percentile([42], 0.95)).toBe(42);
    });
  });
});
