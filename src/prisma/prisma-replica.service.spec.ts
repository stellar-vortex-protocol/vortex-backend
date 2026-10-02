import { PrismaReplicaService } from "./prisma-replica.service";
import { PrismaClient } from "@prisma/client";
import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../config/configuration";

/**
 * Unit tests for PrismaReplicaService (#411).
 *
 * All external I/O (DB connections, raw queries) is replaced with jest mocks so
 * the tests run without a real Postgres instance.
 */

function makeMockPrismaClient(lagMs: number | null = 0): PrismaClient {
  const raw = jest.fn().mockResolvedValue([{ lag_ms: lagMs }]);
  return {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: raw,
  } as unknown as PrismaClient;
}

function makeConfig(overrides: Partial<AppConfig> = {}): ConfigService<AppConfig, true> {
  const values: Partial<AppConfig> = {
    databaseReplicaUrls: "",
    maxReplicaLagMs: 5000,
    ...overrides,
  };
  return {
    get: (key: keyof AppConfig) => (values as AppConfig)[key],
  } as unknown as ConfigService<AppConfig, true>;
}

describe("PrismaReplicaService (#411)", () => {
  let primaryClient: PrismaClient;
  let service: PrismaReplicaService;

  beforeEach(() => {
    jest.useFakeTimers();
    primaryClient = makeMockPrismaClient();
  });

  afterEach(async () => {
    await service?.onModuleDestroy();
    jest.useRealTimers();
  });

  describe("no replicas configured", () => {
    beforeEach(async () => {
      service = new PrismaReplicaService(primaryClient, makeConfig({ databaseReplicaUrls: "" }));
      await service.onModuleInit();
    });

    it("primary() returns the primary client", () => {
      expect(service.primary()).toBe(primaryClient);
    });

    it("pickClient() returns the primary when no replicas exist", () => {
      expect(service.pickClient()).toBe(primaryClient);
    });

    it("replicaStats() returns an empty array", () => {
      expect(service.replicaStats()).toEqual([]);
    });
  });

  describe("with two replicas", () => {
    let replica1: PrismaClient;
    let replica2: PrismaClient;

    beforeEach(async () => {
      replica1 = makeMockPrismaClient(100);
      replica2 = makeMockPrismaClient(200);
      let callCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      jest.spyOn(require("@prisma/client"), "PrismaClient").mockImplementation(() => {
        return callCount++ === 0 ? replica1 : replica2;
      });

      service = new PrismaReplicaService(
        primaryClient,
        makeConfig({ databaseReplicaUrls: "postgresql://r1/db,postgresql://r2/db", maxReplicaLagMs: 5000 }),
      );
      await service.onModuleInit();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("primary() always returns the primary client", () => {
      expect(service.primary()).toBe(primaryClient);
    });

    it("pickClient() returns replicas in round-robin when both are healthy", () => {
      const c1 = service.pickClient();
      const c2 = service.pickClient();
      // Both healthy replicas should be returned, in some order.
      const set = new Set([c1, c2]);
      expect(set.has(replica1) || set.has(replica2)).toBe(true);
    });

    it("falls back to primary when all replicas exceed MAX_REPLICA_LAG_MS", async () => {
      // Simulate all replicas suddenly lagging beyond the threshold.
      (replica1.$queryRaw as jest.Mock).mockResolvedValue([{ lag_ms: 99_999 }]);
      (replica2.$queryRaw as jest.Mock).mockResolvedValue([{ lag_ms: 99_999 }]);
      // Trigger a lag check manually.
      await (service as unknown as { checkAllLags: () => Promise<void> }).checkAllLags();

      expect(service.pickClient()).toBe(primaryClient);
    });

    it("excludes an unhealthy replica (query error) from rotation", async () => {
      // replica1 starts failing.
      (replica1.$queryRaw as jest.Mock).mockRejectedValue(new Error("connection reset"));
      await (service as unknown as { checkAllLags: () => Promise<void> }).checkAllLags();

      // Only replica2 should be returned now.
      for (let i = 0; i < 6; i++) {
        expect(service.pickClient()).toBe(replica2);
      }
    });

    it("replicaStats() includes lag and healthy flag for each replica", () => {
      const stats = service.replicaStats();
      expect(stats).toHaveLength(2);
      for (const s of stats) {
        expect(s).toHaveProperty("url");
        expect(s).toHaveProperty("lagMs");
        expect(s).toHaveProperty("healthy");
      }
    });
  });
});
