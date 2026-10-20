import { AnalyticsService } from "./analytics.service";
import { InMemoryAnalyticsStore } from "./analytics.store";
import { Intent } from "../intents/intents.types";

function filledIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "intent-1",
    user: "GUSER1",
    srcChain: "stellar",
    srcToken: { address: "CUSDC", symbol: "USDC", name: "USD Coin", decimals: 7, chain: "stellar" },
    srcAmount: "1000000",
    dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "filled",
    createdAt: 1_000_000,
    deadline: 1_001_800,
    filledAt: 1_000_030,
    fillAmount: "5000000",
    feeAmount: "250",
    solver: "SOLVER_A",
    version: 0,
    srcVerified: true,
    ...overrides,
  };
}

function makeService() {
  const store = new InMemoryAnalyticsStore();
  const service = new AnalyticsService(store);
  return { service, store };
}

describe("AnalyticsService", () => {
  it("recordFill ingests a filled intent and ignores non-filled ones", async () => {
    const { service, store } = makeService();

    const inserted = await service.recordFill(filledIntent());
    const ignored = await service.recordFill(filledIntent({ state: "open", intentId: "intent-2" }));

    expect(inserted).toBe(1);
    expect(ignored).toBe(0);

    const points = await store.queryVolume({
      interval: "1d",
      from: 1_000_000 * 1000,
      to: 1_010_000 * 1000,
    });
    expect(points[0].volume).toBe("5000000");
  });

  it("backfill replays historical fills and is idempotent", async () => {
    const { service } = makeService();
    const intents = [
      filledIntent({ intentId: "a", fillAmount: "100" }),
      filledIntent({ intentId: "b", fillAmount: "200" }),
      filledIntent({ intentId: "c", state: "cancelled", fillAmount: "999" }), // ignored
    ];

    const first = await service.backfill(intents);
    const second = await service.backfill(intents);

    expect(first).toBe(2);
    expect(second).toBe(0);
  });

  it("maps duration from filledAt - createdAt in milliseconds", async () => {
    const { service, store } = makeService();
    await service.recordFill(filledIntent({ createdAt: 1_000_000, filledAt: 1_000_030 }));

    const points = await store.queryLatency({
      interval: "1d",
      from: 1_000_000 * 1000,
      to: 1_010_000 * 1000,
    });
    expect(points[0].avgMs).toBe(30_000);
    expect(points[0].count).toBe(1);
  });

  describe("getSolverBenchmark", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 0, 1, h, m, 0);
    const fill = (eventId: string, solver: string, timestamp: number, durationMs: number, volume: bigint) => ({
      eventId,
      timestamp,
      chain: "stellar",
      srcToken: "USDC",
      dstToken: "XLM",
      solver,
      volume,
      fees: 0n,
      durationMs,
    });
    const query = { interval: "1h" as const, from: at(0), to: at(23) };

    it("compares the solver with the median solver, odd number of solvers", async () => {
      const { service, store } = makeService();
      await store.ingest([
        fill("a1", "A", at(1), 100, 10n),
        fill("a2", "A", at(1, 5), 300, 10n), // A: avg 200, volume 20
        fill("b1", "B", at(1), 600, 50n), // B: avg 600, volume 50
        fill("c1", "C", at(1), 400, 30n), // C: avg 400, volume 30
      ]);

      const [point] = await service.getSolverBenchmark(query, "A");
      expect(point).toEqual({
        start: "2026-01-01T01:00:00.000Z",
        solver: { avgMs: 200, volume: "20", count: 2 },
        protocol: { medianAvgMs: 400, medianVolume: "30", solverCount: 3 },
      });
    });

    it("averages the two middle solvers for an even number of solvers", async () => {
      const { service, store } = makeService();
      await store.ingest([
        fill("a", "A", at(1), 100, 10n),
        fill("b", "B", at(1), 200, 20n),
        fill("c", "C", at(1), 300, 31n),
        fill("d", "D", at(1), 900, 90n),
      ]);

      const [point] = await service.getSolverBenchmark(query, "D");
      expect(point.protocol).toEqual({ medianAvgMs: 250, medianVolume: "25", solverCount: 4 });
      expect(point.solver).toEqual({ avgMs: 900, volume: "90", count: 1 });
    });

    it("keeps buckets where the solver had no fills, with solver: null", async () => {
      const { service, store } = makeService();
      await store.ingest([
        fill("a", "A", at(1), 100, 10n),
        fill("b", "B", at(2), 500, 40n), // A is absent from the 02:00 bucket
      ]);

      const points = await service.getSolverBenchmark(query, "A");
      expect(points).toHaveLength(2);
      expect(points[0].solver).not.toBeNull();
      expect(points[1]).toEqual({
        start: "2026-01-01T02:00:00.000Z",
        solver: null,
        protocol: { medianAvgMs: 500, medianVolume: "40", solverCount: 1 },
      });
    });

    it("ignores a solver filter on the incoming query for the protocol side", async () => {
      const { service, store } = makeService();
      await store.ingest([fill("a", "A", at(1), 100, 10n), fill("b", "B", at(1), 300, 30n)]);
      const [point] = await service.getSolverBenchmark({ ...query, solver: "B" }, "A");
      expect(point.protocol.solverCount).toBe(2);
      expect(point.solver?.avgMs).toBe(100);
    });
  });
});
