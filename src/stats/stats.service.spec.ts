import { StatsService } from "./stats.service";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { Intent } from "../intents/intents.types";
import { SolverRecord } from "../solvers/solvers.types";

// ─── helpers ────────────────────────────────────────────────────────────────

function baseIntent(overrides: Partial<Intent> & { isCanary?: boolean } = {}): Intent {
  return {
    intentId: "id-1",
    user: "GUSER1",
    srcChain: "ethereum",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: 1_000_000,
    deadline: 1_001_800,
    ...overrides,
  };
}

function baseSolver(overrides: Partial<SolverRecord> = {}): SolverRecord {
  return {
    address: "SOLVER_A",
    name: "Alpha",
    bondAmount: "1000",
    fillsCompleted: 5,
    fillsFailed: 1,
    totalVolume: "5000000",
    avgFillTime: 30,
    isActive: true,
    registeredAt: 900_000,
    lastActiveAt: 900_000,
    supportedChains: ["stellar"],
    supportedTokens: ["USDC"],
    ...overrides,
  };
}

function makeDeps(intents: Intent[], solvers: SolverRecord[]) {
  const intentsService = { getAll: jest.fn().mockResolvedValue(intents) } as unknown as IntentsService;
  const solversService = { getAll: jest.fn().mockResolvedValue(solvers) } as unknown as SolversService;
  const intentsGateway = { getSubscriberCount: jest.fn().mockReturnValue(0) } as unknown as import("../intents/intents.gateway").IntentsGateway;
  const service = new StatsService(intentsService, solversService, intentsGateway);
  return { service, intentsService, solversService };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("StatsService", () => {
  describe("getProtocolStats() — empty store", () => {
    it("returns all-zero / empty stats when there are no intents or solvers", async () => {
      const { service } = makeDeps([], []);
      const stats = await service.getProtocolStats();

      expect(stats.totalIntents).toBe(0);
      expect(stats.openIntents).toBe(0);
      expect(stats.totalVolume).toBe("0");
      expect(stats.uniqueUsers).toBe(0);
      expect(stats.activeSolvers).toBe(0);
      expect(stats.avgFillTime).toBe(0);
      expect(stats.fillRate).toBe(0);
    });
  });

  // ── totalIntents & openIntents ─────────────────────────────────────────────

  describe("totalIntents and openIntents", () => {
    it("counts all intents regardless of state", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "open" }),
        baseIntent({ intentId: "b", state: "filled" }),
        baseIntent({ intentId: "c", state: "cancelled" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).totalIntents).toBe(3);
    });

    it("counts only open intents for openIntents", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "open" }),
        baseIntent({ intentId: "b", state: "open" }),
        baseIntent({ intentId: "c", state: "filled" }),
        baseIntent({ intentId: "d", state: "cancelled" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).openIntents).toBe(2);
    });

    it("openIntents is 0 when no intents are open", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "500" }),
        baseIntent({ intentId: "b", state: "cancelled" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).openIntents).toBe(0);
    });
  });

  // ── totalVolume (BigInt reduce) ────────────────────────────────────────────

  describe("totalVolume", () => {
    it("is '0' when there are no filled intents", async () => {
      const intents = [baseIntent({ intentId: "a", state: "open" })];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).totalVolume).toBe("0");
    });

    it("sums fillAmount of filled intents correctly", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "1000000" }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "2000000" }),
        baseIntent({ intentId: "c", state: "open" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).totalVolume).toBe("3000000");
    });

    it("treats missing fillAmount as zero when state is filled", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: undefined }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "500000" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).totalVolume).toBe("500000");
    });

    it("returns volume as a string (not a number)", async () => {
      const intents = [baseIntent({ intentId: "a", state: "filled", fillAmount: "9999999999999999999" })];
      const { service } = makeDeps(intents, []);
      const { totalVolume } = await service.getProtocolStats();
      expect(typeof totalVolume).toBe("string");
      expect(totalVolume).toBe("9999999999999999999");
    });

    it("handles large values correctly via BigInt arithmetic", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "9007199254740993" }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "9007199254740993" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).totalVolume).toBe("18014398509481986");
    });
  });

  // ── uniqueUsers ────────────────────────────────────────────────────────────

  describe("uniqueUsers", () => {
    it("counts distinct user addresses", async () => {
      const intents = [
        baseIntent({ intentId: "a", user: "GUSER1" }),
        baseIntent({ intentId: "b", user: "GUSER2" }),
        baseIntent({ intentId: "c", user: "GUSER1" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).uniqueUsers).toBe(2);
    });

    it("is 0 when there are no intents", async () => {
      const { service } = makeDeps([], []);
      expect((await service.getProtocolStats()).uniqueUsers).toBe(0);
    });
  });

  // ── activeSolvers ──────────────────────────────────────────────────────────

  describe("activeSolvers", () => {
    it("counts only solvers where isActive is true", async () => {
      const solvers = [
        baseSolver({ address: "S1", isActive: true }),
        baseSolver({ address: "S2", isActive: false }),
        baseSolver({ address: "S3", isActive: true }),
      ];
      const { service } = makeDeps([], solvers);
      expect((await service.getProtocolStats()).activeSolvers).toBe(2);
    });

    it("is 0 when there are no active solvers", async () => {
      const solvers = [baseSolver({ address: "S1", isActive: false })];
      const { service } = makeDeps([], solvers);
      expect((await service.getProtocolStats()).activeSolvers).toBe(0);
    });
  });

  // ── avgFillTime ────────────────────────────────────────────────────────────

  describe("avgFillTime", () => {
    it("is 0 when there are no filled intents", async () => {
      const intents = [baseIntent({ intentId: "a", state: "open" })];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).avgFillTime).toBe(0);
    });

    it("is 0 when filled intents all have filledAt unset", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100", filledAt: undefined }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "200", filledAt: undefined }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).avgFillTime).toBe(0);
    });

    it("computes average as Math.round((filledAt - createdAt) across filled intents)", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100", createdAt: 1000, filledAt: 1030 }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "200", createdAt: 1000, filledAt: 1050 }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).avgFillTime).toBe(40);
    });

    it("rounds fractional averages", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100", createdAt: 1000, filledAt: 1010 }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "100", createdAt: 1000, filledAt: 1011 }),
        baseIntent({ intentId: "c", state: "filled", fillAmount: "100", createdAt: 1000, filledAt: 1012 }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).avgFillTime).toBe(11);
    });

    it("excludes filled intents without filledAt from the average calculation", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100", createdAt: 1000, filledAt: 1060 }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "100", filledAt: undefined }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).avgFillTime).toBe(60);
    });
  });

  // ── fillRate (divide-by-zero guard) ────────────────────────────────────────

  describe("fillRate", () => {
    it("is 0 when there are no intents (divide-by-zero guard)", async () => {
      const { service } = makeDeps([], []);
      expect((await service.getProtocolStats()).fillRate).toBe(0);
    });

    it("is 0 when there are intents but none are filled", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "open" }),
        baseIntent({ intentId: "b", state: "cancelled" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).fillRate).toBe(0);
    });

    it("is 1 when all intents are filled", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100" }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "200" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).fillRate).toBe(1);
    });

    it("calculates the correct fractional rate", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100" }),
        baseIntent({ intentId: "b", state: "open" }),
        baseIntent({ intentId: "c", state: "open" }),
        baseIntent({ intentId: "d", state: "open" }),
      ];
      const { service } = makeDeps(intents, []);
      expect((await service.getProtocolStats()).fillRate).toBeCloseTo(0.25);
    });

    it("is a number between 0 and 1 inclusive", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100" }),
        baseIntent({ intentId: "b", state: "filled", fillAmount: "200" }),
        baseIntent({ intentId: "c", state: "open" }),
      ];
      const { service } = makeDeps(intents, []);
      const { fillRate } = await service.getProtocolStats();
      expect(fillRate).toBeGreaterThanOrEqual(0);
      expect(fillRate).toBeLessThanOrEqual(1);
    });
  });

  // ── shape / return type ────────────────────────────────────────────────────

  describe("return shape", () => {
    it("returns an object with all expected keys", async () => {
      const { service } = makeDeps([], []);
      const stats = await service.getProtocolStats();

      expect(stats).toHaveProperty("totalIntents");
      expect(stats).toHaveProperty("openIntents");
      expect(stats).toHaveProperty("totalVolume");
      expect(stats).toHaveProperty("uniqueUsers");
      expect(stats).toHaveProperty("activeSolvers");
      expect(stats).toHaveProperty("avgFillTime");
      expect(stats).toHaveProperty("fillRate");
    });

    it("totalVolume is always a string", async () => {
      const { service } = makeDeps([], []);
      expect(typeof (await service.getProtocolStats()).totalVolume).toBe("string");
    });

    it("delegates to intentsService.getAll() and solversService.getAll() each call", async () => {
      const { service, intentsService, solversService } = makeDeps([], []);
      await service.getProtocolStats();
      await service.getProtocolStats();
      expect(intentsService.getAll).toHaveBeenCalledTimes(2);
      expect(solversService.getAll).toHaveBeenCalledTimes(2);
    });
  });

  // ── computeStatsForWindow ──────────────────────────────────────────────────

  describe("computeStatsForWindow()", () => {
    const NOW = 10_000_000;
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
      nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it("includes only intents created at or after the window start", async () => {
      const intents = [
        baseIntent({ intentId: "recent", state: "filled", fillAmount: "100", createdAt: NOW - 60 }),
        baseIntent({ intentId: "old", state: "filled", fillAmount: "900", createdAt: NOW - 7200 }),
      ];
      const { service } = makeDeps(intents, []);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.totalIntents).toBe(1);
      expect(stats.totalVolume).toBe("100");
    });

    it("treats an intent created exactly at the window boundary as inside the window", async () => {
      const intents = [
        baseIntent({ intentId: "boundary", state: "filled", fillAmount: "42", createdAt: NOW - 3600 }),
      ];
      const { service } = makeDeps(intents, []);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.totalIntents).toBe(1);
      expect(stats.totalVolume).toBe("42");
    });

    it("excludes intents created one second before the window start", async () => {
      const intents = [
        baseIntent({ intentId: "just-outside", state: "filled", fillAmount: "42", createdAt: NOW - 3601 }),
      ];
      const { service } = makeDeps(intents, []);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.totalIntents).toBe(0);
      expect(stats.totalVolume).toBe("0");
    });

    it("returns zero-safe avgFillTime and fillRate for an empty window", async () => {
      const intents = [baseIntent({ intentId: "old", state: "filled", fillAmount: "100", createdAt: NOW - 100_000 })];
      const { service } = makeDeps(intents, []);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.avgFillTime).toBe(0);
      expect(stats.fillRate).toBe(0);
      expect(Number.isNaN(stats.avgFillTime)).toBe(false);
      expect(Number.isFinite(stats.fillRate)).toBe(true);
    });

    it("computes avgFillTime and fillRate only from in-window intents", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100", createdAt: NOW - 100, filledAt: NOW - 40 }),
        baseIntent({ intentId: "b", state: "open", createdAt: NOW - 200 }),
        baseIntent({ intentId: "c", state: "filled", fillAmount: "999", createdAt: NOW - 100_000, filledAt: NOW - 99_000 }),
      ];
      const { service } = makeDeps(intents, []);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.totalIntents).toBe(2);
      expect(stats.avgFillTime).toBe(60);
      expect(stats.fillRate).toBeCloseTo(0.5);
    });

    it("counts uniqueUsers and activeSolvers within the window", async () => {
      const intents = [
        baseIntent({ intentId: "a", user: "GUSER1", createdAt: NOW - 100 }),
        baseIntent({ intentId: "b", user: "GUSER1", createdAt: NOW - 200 }),
        baseIntent({ intentId: "c", user: "GUSER2", createdAt: NOW - 100_000 }),
      ];
      const solvers = [baseSolver({ address: "S1", isActive: true })];
      const { service } = makeDeps(intents, solvers);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.uniqueUsers).toBe(1);
      expect(stats.activeSolvers).toBe(1);
    });

    it("excludes canary intents from the window", async () => {
      const intents = [
        baseIntent({ intentId: "real", state: "filled", fillAmount: "100", createdAt: NOW - 100 }),
        baseIntent({ intentId: "canary", state: "filled", fillAmount: "5000", createdAt: NOW - 100, isCanary: true }),
      ];
      const { service } = makeDeps(intents, []);
      const stats = await service.computeStatsForWindow(NOW - 3600);
      expect(stats.totalIntents).toBe(1);
      expect(stats.totalVolume).toBe("100");
    });
  });

  // ── getWindowedStats ───────────────────────────────────────────────────────

  describe("getWindowedStats()", () => {
    const NOW = 10_000_000;
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
      nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it("returns 1h, 24h, 7d and allTime keys", async () => {
      const { service } = makeDeps([], []);
      const windows = await service.getWindowedStats();
      expect(Object.keys(windows).sort()).toEqual(["1h", "24h", "7d", "allTime"].sort());
    });

    it("buckets intents by age into the correct windows", async () => {
      const intents = [
        baseIntent({ intentId: "fresh", state: "filled", fillAmount: "1", createdAt: NOW - 60 }),
        baseIntent({ intentId: "day", state: "filled", fillAmount: "10", createdAt: NOW - 3600 * 5 }),
        baseIntent({ intentId: "week", state: "filled", fillAmount: "100", createdAt: NOW - 3600 * 24 * 3 }),
        baseIntent({ intentId: "ancient", state: "filled", fillAmount: "1000", createdAt: NOW - 3600 * 24 * 30 }),
      ];
      const { service } = makeDeps(intents, []);
      const windows = await service.getWindowedStats();

      expect(windows["1h"].totalIntents).toBe(1);
      expect(windows["1h"].totalVolume).toBe("1");

      expect(windows["24h"].totalIntents).toBe(2);
      expect(windows["24h"].totalVolume).toBe("11");

      expect(windows["7d"].totalIntents).toBe(3);
      expect(windows["7d"].totalVolume).toBe("111");

      expect(windows.allTime.totalIntents).toBe(4);
      expect(windows.allTime.totalVolume).toBe("1111");
    });

    it("never includes an intent in a window older than its age", async () => {
      const intents = [
        baseIntent({ intentId: "two-hours", state: "filled", fillAmount: "7", createdAt: NOW - 3600 * 2 }),
      ];
      const { service } = makeDeps(intents, []);
      const windows = await service.getWindowedStats();

      expect(windows["1h"].totalIntents).toBe(0);
      expect(windows["24h"].totalIntents).toBe(1);
      expect(windows["7d"].totalIntents).toBe(1);
      expect(windows.allTime.totalIntents).toBe(1);
    });

    it("returns zero-safe metrics for empty windows", async () => {
      const { service } = makeDeps([], []);
      const windows = await service.getWindowedStats();
      for (const key of ["1h", "24h", "7d", "allTime"] as const) {
        expect(windows[key].avgFillTime).toBe(0);
        expect(windows[key].fillRate).toBe(0);
        expect(windows[key].totalVolume).toBe("0");
      }
    });

    it("excludes canary intents from every window", async () => {
      const intents = [
        baseIntent({ intentId: "canary", state: "filled", fillAmount: "5000", createdAt: NOW - 60, isCanary: true }),
      ];
      const { service } = makeDeps(intents, []);
      const windows = await service.getWindowedStats();
      for (const key of ["1h", "24h", "7d", "allTime"] as const) {
        expect(windows[key].totalIntents).toBe(0);
        expect(windows[key].totalVolume).toBe("0");
      }
    });

    it("allTime matches getProtocolStats()", async () => {
      const intents = [
        baseIntent({ intentId: "a", state: "filled", fillAmount: "100", createdAt: NOW - 60, filledAt: NOW - 30 }),
        baseIntent({ intentId: "b", state: "open", createdAt: NOW - 3600 * 24 * 10 }),
      ];
      const { service } = makeDeps(intents, []);
      const windows = await service.getWindowedStats();
      const allTime = await service.getProtocolStats();
      expect(windows.allTime).toEqual(allTime);
    });
  });
});
