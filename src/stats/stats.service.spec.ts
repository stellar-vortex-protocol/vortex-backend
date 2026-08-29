import { StatsService } from "./stats.service";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { Intent } from "../intents/intents.types";
import { SolverRecord } from "../solvers/solvers.types";

// ─── helpers ────────────────────────────────────────────────────────────────

function baseIntent(overrides: Partial<Intent> = {}): Intent {
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
});
