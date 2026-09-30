import { DatasetsService } from "./datasets.service";
import { InMemoryObjectStorage } from "./object-storage";
import { DatasetsConfig } from "./datasets.types";
import { Intent } from "../intents/intents.types";
import { SolverRecord } from "../solvers/solvers.types";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { ParquetReader } from "parquetjs";

function makeConfig(overrides: Partial<DatasetsConfig> = {}): DatasetsConfig {
  return {
    enabled: true,
    anonymize: true,
    salt: "0123456789abcdef0123456789abcdef",
    saltRotationHours: 24,
    saltRetentionWindows: 2,
    publicBucket: "vortex-public-datasets",
    storageKind: "memory",
    localDir: ".datasets",
    ...overrides,
  };
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: "intent-1",
    user: "GUSER1",
    srcChain: "stellar",
    srcToken: { address: "CSTELLAR", symbol: "USDC", name: "USD Coin", decimals: 7, chain: "stellar" },
    srcAmount: "1000000",
    dstToken: { contract: "CDST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: 1_000_000,
    deadline: 1_001_800,
    version: 0,
    srcVerified: true,
    ...overrides,
  };
}

function makeSolver(overrides: Partial<SolverRecord> = {}): SolverRecord {
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
    lastActiveAt: 1_000_500,
    supportedChains: ["stellar"],
    supportedTokens: ["USDC"],
    ...overrides,
  };
}

function makeService(
  intents: Intent[],
  solvers: SolverRecord[],
  config: DatasetsConfig = makeConfig(),
) {
  const intentsService = { getAll: jest.fn().mockResolvedValue(intents) } as unknown as IntentsService;
  const solversService = { getAll: jest.fn().mockResolvedValue(solvers) } as unknown as SolversService;
  const storage = new InMemoryObjectStorage();
  const service = new DatasetsService(config, storage, intentsService, solversService);
  return { service, storage, intentsService, solversService };
}

describe("DatasetsService", () => {
  describe("exportDaily", () => {
    it("publishes CSV + Parquet + manifest for a day's intents", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [
        makeIntent({ intentId: "a", createdAt: day + 100, state: "filled", filledAt: day + 200, fillAmount: "500", feeAmount: "5" }),
        makeIntent({ intentId: "b", createdAt: day + 300 }),
      ];
      const solvers = [makeSolver()];

      const { service, storage } = makeService(intents, solvers);
      const manifest = await service.exportDaily(new Date("2026-09-28T12:00:00Z"));

      expect(manifest.date).toBe("2026-09-28");
      expect(manifest.revision).toBe(1);
      expect(manifest.rowCounts.intents).toBe(2);
      expect(manifest.rowCounts.fills).toBe(1);
      expect(manifest.rowCounts.fees).toBe(1);
      expect(manifest.rowCounts.solver_stats).toBe(1);

      // CSV + Parquet exist for intents; Parquet omitted only when zero rows.
      const csv = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/intents.csv");
      expect(csv).not.toBeNull();
      expect(csv!.toString("utf8")).toContain("intentId,user,srcChain");

      const parquet = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/intents.parquet");
      expect(parquet).not.toBeNull();

      const manifestBytes = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/manifest.json");
      expect(manifestBytes).not.toBeNull();
    });

    it("records a watermark equal to the max event timestamp", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [
        makeIntent({ intentId: "a", createdAt: day + 100, filledAt: day + 900 }),
        makeIntent({ intentId: "b", createdAt: day + 500 }),
      ];
      const { service } = makeService(intents, []);
      const manifest = await service.exportDaily(new Date("2026-09-28T12:00:00Z"));

      expect(manifest.watermark).toBe(new Date((day + 900) * 1000).toISOString());
    });

    it("increments revision when a date is re-published (reconciliation)", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [makeIntent({ intentId: "a", createdAt: day + 100 })];
      const { service } = makeService(intents, []);

      const first = await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
      const second = await service.exportDaily(new Date("2026-09-28T12:00:00Z"));

      expect(first.revision).toBe(1);
      expect(second.revision).toBe(2);
    });

    it("hashes user addresses when anonymisation is enabled", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [makeIntent({ intentId: "a", user: "GUSER1", createdAt: day + 100 })];
      const { service, storage } = makeService(intents, [], makeConfig({ anonymize: true }));

      await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
      const csv = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/intents.csv");
      expect(csv!.toString("utf8")).not.toContain("GUSER1");
    });

    it("leaves user addresses raw when anonymisation is disabled", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [makeIntent({ intentId: "a", user: "GUSER1", createdAt: day + 100 })];
      const { service, storage } = makeService(intents, [], makeConfig({ anonymize: false }));

      await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
      const csv = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/intents.csv");
      expect(csv!.toString("utf8")).toContain("GUSER1");
    });
  });

  describe("listDatasets", () => {
    it("returns published dates with their schemas and revisions", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [makeIntent({ intentId: "a", createdAt: day + 100 })];
      const { service } = makeService(intents, []);

      await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
      const publications = await service.listDatasets();

      expect(publications).toHaveLength(1);
      expect(publications[0].date).toBe("2026-09-28");
      expect(publications[0].revision).toBe(1);
      expect(publications[0].datasets.some((d) => d.kind === "intents")).toBe(true);
    });
  });

  describe("listSchemas", () => {
    it("lists every dataset kind with its versioned schema", () => {
      const { service } = makeService([], []);
      const schemas = service.listSchemas();
      expect(schemas.map((s) => s.kind)).toEqual(["intents", "fills", "solver_stats", "fees"]);
      expect(schemas[0].schema).toBe("intents-v1.0");
      expect(schemas[0].fields.length).toBeGreaterThan(0);
    });
  });

  describe("parquet round-trip of exported files", () => {
    it("produces Parquet that a reader can parse back", async () => {
      const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;
      const intents = [
        makeIntent({ intentId: "a", createdAt: day + 100, state: "filled", filledAt: day + 200, fillAmount: "500", feeAmount: "5" }),
      ];
      const { service, storage } = makeService(intents, [makeSolver()]);
      await service.exportDaily(new Date("2026-09-28T12:00:00Z"));

      const parquet = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/fills.parquet");
      expect(parquet).not.toBeNull();

      const fs = await import("fs/promises");
      const os = await import("os");
      const nodePath = await import("path");
      // OS temp dir rather than a hard-coded /tmp (absent on Windows).
      const tmp = nodePath.join(os.tmpdir(), `svc-roundtrip-${Date.now()}.parquet`);
      await fs.writeFile(tmp, parquet!);
      const reader = await ParquetReader.openFile(tmp);
      const cursor = reader.getCursor();
      const rows: Record<string, unknown>[] = [];
      let row;
      while ((row = await cursor.next())) rows.push(row as Record<string, unknown>);
      await reader.close();
      await fs.unlink(tmp);

      expect(rows).toHaveLength(1);
      expect(rows[0].intentId).toBe("a");
      expect(rows[0].fillAmount).toBe("500");
    });
  });
});
