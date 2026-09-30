import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { compareStores, IntentsStoreVerifierService } from "./intents-store-verifier.service";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { Intent } from "./intents.types";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentId: uuidv4(),
    user: "GVERIFY",
    srcChain: "base",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "base" },
    srcAmount: "1",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "1",
    state: "open",
    createdAt: 1,
    deadline: 2,
    version: 0,
    srcVerified: true,
    ...overrides,
  };
}

const config = { get: () => 60_000 } as unknown as ConfigService<AppConfig, true>;

describe("compareStores", () => {
  it("reports no mismatches for identical snapshots, ignoring key order", () => {
    const a = makeIntent({ srcToken: { address: "0x1", symbol: "S", name: "N", decimals: 6, chain: "base" } });
    const b = { ...a, srcToken: { chain: "base" as const, decimals: 6, name: "N", symbol: "S", address: "0x1" } };
    expect(compareStores([a], [b]).mismatches).toEqual({
      missing_in_postgres: 0,
      missing_in_memory: 0,
      field_mismatch: 0,
    });
  });

  it("classifies each kind of mismatch and names differing fields", () => {
    const same = makeIntent();
    const memoryOnly = makeIntent();
    const dbOnly = makeIntent();
    const drifted = makeIntent();
    const report = compareStores(
      [same, memoryOnly, drifted],
      [same, dbOnly, { ...drifted, state: "cancelled", version: 1 }],
    );

    expect(report.mismatches).toEqual({ missing_in_postgres: 1, missing_in_memory: 1, field_mismatch: 1 });
    expect(report.samples).toContainEqual({ intentId: drifted.intentId, kind: "field_mismatch", fields: ["state", "version"] });
    expect(report.memoryCount).toBe(3);
    expect(report.postgresCount).toBe(3);
  });

  it("caps samples at five while still counting every mismatch", () => {
    const memory = Array.from({ length: 8 }, () => makeIntent());
    const report = compareStores(memory, []);
    expect(report.mismatches.missing_in_postgres).toBe(8);
    expect(report.samples).toHaveLength(5);
  });
});

describe("IntentsStoreVerifierService", () => {
  afterEach(() => jest.useRealTimers());

  it("is inert when the store is not dual", async () => {
    const service = new IntentsStoreVerifierService(new InMemoryIntentsRepository(), config);
    expect(service.enabled).toBe(false);
    await service.onModuleInit();
    expect(await service.verify()).toBeNull();
  });

  it("backfills on boot and publishes mismatch counts to metrics", async () => {
    const primary = new InMemoryIntentsRepository({ seed: false });
    const secondary = new InMemoryIntentsRepository({ seed: false });
    Object.assign(secondary, { saveIfNewer: jest.fn().mockResolvedValue(undefined) });
    const repo = new DualWriteIntentsRepository(primary, secondary as unknown as PrismaIntentsRepository);
    const metrics = { recordStoreVerification: jest.fn() };
    const service = new IntentsStoreVerifierService(repo, config, metrics as unknown as MetricsService);
    const backfill = jest.spyOn(repo, "backfill");

    await service.onModuleInit();
    primary.save(makeIntent());
    const report = await service.verify();
    service.onModuleDestroy();

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(report?.mismatches.missing_in_postgres).toBe(1);
    expect(metrics.recordStoreVerification).toHaveBeenCalledWith({
      missing_in_postgres: 1,
      missing_in_memory: 0,
      field_mismatch: 0,
    });
  });
});
