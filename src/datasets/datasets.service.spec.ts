import { DatasetsService } from "./datasets.service";
import { InMemoryObjectStorage } from "./object-storage";
import { DatasetsConfig } from "./datasets.types";
import { Intent } from "../intents/intents.types";
import { SolverRecord } from "../solvers/solvers.types";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { ParquetReader } from "parquetjs";
import { DatasetWebhookNotifier, WebhookEgress, verifyDatasetWebhookSignature } from "./dataset-webhook.notifier";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Anonymizer } from "./privacy";
import { checksum } from "./manifest";
import { DATASET_SCHEMAS, fieldNames } from "./schemas";

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
  notifier?: DatasetWebhookNotifier,
) {
  const intentsService = { getAll: jest.fn().mockResolvedValue(intents) } as unknown as IntentsService;
  const solversService = { getAll: jest.fn().mockResolvedValue(solvers) } as unknown as SolversService;
  const storage = new InMemoryObjectStorage();
  const service = new DatasetsService(config, storage, intentsService, solversService, notifier);
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

  describe("getLatest", () => {
    const at = (date: string) => new Date(`${date}T12:00:00Z`);
    const dayIntent = (date: string) =>
      makeIntent({ intentId: `i-${date}`, createdAt: new Date(`${date}T01:00:00Z`).getTime() / 1000 });

    it("returns null on a freshly-provisioned bucket with no manifests", async () => {
      const { service } = makeService([], []);
      await expect(service.getLatest()).resolves.toBeNull();
    });

    it("returns the only publication when there is one", async () => {
      const { service } = makeService([dayIntent("2026-09-28")], []);
      await service.exportDaily(at("2026-09-28"));

      const latest = await service.getLatest();
      expect(latest).toMatchObject({ date: "2026-09-28", revision: 1 });
      expect(latest).toEqual((await service.listDatasets())[0]);
    });

    it("returns the highest revision of the newest date", async () => {
      const { service } = makeService([dayIntent("2026-09-27"), dayIntent("2026-09-28")], []);
      await service.exportDaily(at("2026-09-28")); // rev 1
      await service.exportDaily(at("2026-09-28")); // rev 2
      await service.exportDaily(at("2026-09-28")); // rev 3
      // An older date published afterwards must not win.
      await service.exportDaily(at("2026-09-27"));

      await expect(service.getLatest()).resolves.toMatchObject({ date: "2026-09-28", revision: 3 });
    });
  });

  describe("dataset webhook notifications", () => {
    const SECRET = "dataset-webhook-secret-0123456789abcdef";
    const day = new Date("2026-09-28T00:00:00Z").getTime() / 1000;

    it("POSTs the exact manifest.json bytes with a verifiable signature", async () => {
      const fetch = jest.fn().mockResolvedValue({ statusCode: 204 });
      const notifier = new DatasetWebhookNotifier(
        { webhookUrls: ["https://hooks.example.com/datasets"], webhookSecret: SECRET },
        { fetch } as WebhookEgress,
      );
      const { service, storage } = makeService([makeIntent({ createdAt: day + 1 })], [], makeConfig(), notifier);

      const manifest = await service.exportDaily(new Date("2026-09-28T12:00:00Z"));

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = fetch.mock.calls[0];
      expect(url).toBe("https://hooks.example.com/datasets");
      const stored = await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/manifest.json");
      expect(opts.body).toBe(stored!.toString("utf8"));
      expect(JSON.parse(opts.body)).toEqual(manifest);
      expect(verifyDatasetWebhookSignature(SECRET, opts.body, opts.headers["X-Vortex-Signature"])).toBe(true);
    });

    it("still publishes and returns the manifest when every webhook delivery fails", async () => {
      const fetch = jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      const notifier = new DatasetWebhookNotifier(
        { webhookUrls: ["https://down.example.com/hook", "https://also-down.example.com/hook"], webhookSecret: SECRET },
        { fetch } as WebhookEgress,
        { maxAttempts: 3, sleep: () => Promise.resolve() },
      );
      const { service, storage } = makeService([makeIntent({ createdAt: day + 1 })], [], makeConfig(), notifier);

      const manifest = await service.exportDaily(new Date("2026-09-28T12:00:00Z"));

      expect(manifest).toMatchObject({ date: "2026-09-28", revision: 1 });
      expect(fetch).toHaveBeenCalledTimes(6); // 2 URLs × 3 bounded attempts
      expect(
        await storage.get("vortex-public-datasets/datasets/2026-09-28/rev-1/manifest.json"),
      ).not.toBeNull();
      await expect(service.getLatest()).resolves.toMatchObject({ date: "2026-09-28", revision: 1 });
    });

    it("does not call out when no webhook URLs are configured", async () => {
      const fetch = jest.fn();
      const notifier = new DatasetWebhookNotifier({ webhookUrls: [] }, { fetch } as WebhookEgress);
      const { service } = makeService([], [], makeConfig(), notifier);
      await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
      expect(fetch).not.toHaveBeenCalled();
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

  describe("exportRange", () => {
    const sec = (iso: string) => Date.parse(iso) / 1000;

    function csvRows(body: Buffer): string[][] {
      return body
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(","));
    }

    it("exports every day of an inclusive range as one CSV with a manifest", async () => {
      const intents = [
        makeIntent({ intentId: "before", createdAt: sec("2026-01-31T23:59:59Z") }),
        makeIntent({ intentId: "first", createdAt: sec("2026-02-01T00:00:00Z") }),
        makeIntent({ intentId: "middle", createdAt: sec("2026-02-02T12:00:00Z") }),
        makeIntent({ intentId: "last", createdAt: sec("2026-02-03T23:59:59Z"), filledAt: sec("2026-02-04T00:10:00Z") }),
        makeIntent({ intentId: "after", createdAt: sec("2026-02-04T00:00:00Z") }),
      ];
      const { service, storage } = makeService(intents, []);

      const { manifest, body, contentType } = await service.exportRange({
        kind: "intents",
        from: "2026-02-01",
        to: "2026-02-03",
        format: "csv",
      });

      const [header, ...rows] = csvRows(body);
      expect(header).toEqual(fieldNames(DATASET_SCHEMAS.intents));
      expect(rows.map((r) => r[0])).toEqual(["first", "middle", "last"]);
      expect(contentType).toBe("text/csv; charset=utf-8");
      expect(manifest).toMatchObject({
        schema: "intents-v1.0",
        schemaVersion: "1.0",
        kind: "intents",
        format: "csv",
        from: "2026-02-01",
        to: "2026-02-03",
        rowCount: 3,
        sizeBytes: body.length,
        sha256: checksum(body),
        fileName: "intents_2026-02-01_2026-02-03.csv",
        watermark: "2026-02-04T00:10:00.000Z",
      });
      // On-demand exports are returned, never published.
      expect(await storage.list("")).toEqual([]);
    });

    it("hashes each row with the salt window active at its own timestamp", async () => {
      const config = makeConfig({ saltRotationHours: 6 });
      // 05:59 and 06:01 sit in different 6-hour windows; the next day is a third.
      const times = [sec("2026-02-01T05:59:00Z"), sec("2026-02-01T06:01:00Z"), sec("2026-02-02T01:00:00Z")];
      const intents = times.map((t, i) => makeIntent({ intentId: `i${i}`, user: "GSAME", createdAt: t }));
      const { service } = makeService(intents, [], config);

      const { body } = await service.exportRange({ kind: "intents", from: "2026-02-01", to: "2026-02-02", format: "csv" });
      const users = csvRows(body).slice(1).map((r) => r[1]);

      const anonymizer = new Anonymizer(config.salt, config.saltRotationHours, config.saltRetentionWindows);
      expect(users).toEqual(times.map((t) => anonymizer.hash("GSAME", t * 1000)));
      expect(new Set(users).size).toBe(3);
      expect(users).not.toContain("GSAME");
    });

    it("matches the rows the daily export publishes for the same day", async () => {
      const day = sec("2026-09-28T00:00:00Z");
      const intents = [
        makeIntent({ intentId: "a", createdAt: day + 100, state: "filled", filledAt: day + 200, fillAmount: "500", feeAmount: "5" }),
        makeIntent({ intentId: "b", createdAt: day + 300 }),
      ];
      const { service, storage } = makeService(intents, [makeSolver()]);

      await service.exportDaily(new Date("2026-09-28T12:00:00Z"));
      for (const kind of ["intents", "fills", "fees", "solver_stats"] as const) {
        const daily = await storage.get(`vortex-public-datasets/datasets/2026-09-28/rev-1/${kind}.csv`);
        const ranged = await service.exportRange({ kind, from: "2026-09-28", to: "2026-09-28", format: "csv" });
        expect(ranged.body.toString("utf8")).toBe(daily!.toString("utf8"));
      }
    });

    it("produces a Parquet file readable with the schema's columns", async () => {
      const intents = [
        makeIntent({ intentId: "a", createdAt: sec("2026-02-01T10:00:00Z"), state: "filled", fillAmount: "7", filledAt: sec("2026-02-01T10:01:00Z") }),
      ];
      const { service } = makeService(intents, []);
      const { body, contentType, manifest } = await service.exportRange({
        kind: "fills",
        from: "2026-02-01",
        to: "2026-02-01",
        format: "parquet",
      });
      expect(contentType).toBe("application/vnd.apache.parquet");
      expect(manifest.rowCount).toBe(1);

      const fs = await import("fs/promises");
      const os = await import("os");
      const nodePath = await import("path");
      const tmp = nodePath.join(os.tmpdir(), `range-export-${Date.now()}.parquet`);
      await fs.writeFile(tmp, body);
      const reader = await ParquetReader.openFile(tmp);
      const row = (await reader.getCursor().next()) as Record<string, unknown>;
      await reader.close();
      await fs.unlink(tmp);
      expect(Object.keys(row)).toEqual(expect.arrayContaining(["intentId", "fillAmount"]));
      expect(row.fillAmount).toBe("7");
    });

    it("returns a header-only CSV for an empty range but 404s for empty Parquet", async () => {
      const { service } = makeService([], []);
      const csv = await service.exportRange({ kind: "fills", from: "2026-02-01", to: "2026-02-01", format: "csv" });
      expect(csv.manifest.rowCount).toBe(0);
      expect(csvRows(csv.body)).toEqual([fieldNames(DATASET_SCHEMAS.fills)]);

      await expect(
        service.exportRange({ kind: "fills", from: "2026-02-01", to: "2026-02-01", format: "parquet" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects ranges wider than exportMaxDays", async () => {
      const { service } = makeService([], [], makeConfig({ exportMaxDays: 3 }));
      await expect(
        service.exportRange({ kind: "intents", from: "2026-02-01", to: "2026-02-03", format: "csv" }),
      ).resolves.toBeDefined();
      await expect(
        service.exportRange({ kind: "intents", from: "2026-02-01", to: "2026-02-04", format: "csv" }),
      ).rejects.toThrow(/4 days; the maximum is 3/);
    });

    it.each([
      ["to before from", "2026-02-02", "2026-02-01"],
      ["an impossible date", "2026-02-30", "2026-03-01"],
      ["a non-date", "yesterday", "2026-03-01"],
    ])("rejects %s with 400", async (_label, from, to) => {
      const { service } = makeService([], []);
      await expect(service.exportRange({ kind: "intents", from, to, format: "csv" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
