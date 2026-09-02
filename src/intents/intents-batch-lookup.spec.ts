import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { InMemoryIntentsRepository } from "./intents.repository";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";

/**
 * Issue #275 — service-layer batch lookup used by `POST /api/v1/intents/batch`.
 */
describe("IntentsService.getMany (#275)", () => {
  let service: IntentsService;

  beforeEach(() => {
    const config = {
      get: jest.fn().mockReturnValue(false),
    } as unknown as ConfigService<AppConfig, true>;
    const stellarTx = {} as StellarTxService;
    const prisma = {
      intentAuditLog: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    service = new IntentsService(new InMemoryIntentsRepository(), config, stellarTx, prisma);
  });

  afterEach(() => service.onModuleDestroy());

  function makeIntent() {
    return service.create({
      user: "GTESTBATCHUSER000000",
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: Math.floor(Date.now() / 1000) + 1800,
    });
  }

  it("returns every record when all IDs are found", async () => {
    const a = await makeIntent();
    const b = await makeIntent();

    const result = await service.getMany([a.intentId, b.intentId]);

    expect(result.map((i) => i.intentId).sort()).toEqual([a.intentId, b.intentId].sort());
  });

  it("omits IDs with no matching record (does not 404)", async () => {
    const a = await makeIntent();

    const result = await service.getMany([a.intentId, "does-not-exist"]);

    expect(result).toHaveLength(1);
    expect(result[0].intentId).toBe(a.intentId);
  });

  it("returns an empty array for empty input", async () => {
    expect(await service.getMany([])).toEqual([]);
  });

  it("de-duplicates repeated IDs", async () => {
    const a = await makeIntent();

    const result = await service.getMany([a.intentId, a.intentId, a.intentId]);

    expect(result).toHaveLength(1);
  });
});
