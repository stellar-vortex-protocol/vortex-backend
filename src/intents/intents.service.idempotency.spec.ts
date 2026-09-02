import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IIntentsRepository } from "./intents.repository";
import { Intent } from "./intents.types";
import { AppConfig } from "../config/configuration";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Issue #274 — the idempotency-key path in IntentsService.create() must be
 * race-safe: N concurrent requests carrying the same key produce exactly one
 * intent, and the losers receive the winner's result.
 */

type CreateData = Omit<Intent, "intentId" | "createdAt" | "state">;

const baseData: CreateData = {
  user: "GUSERADDRESS000000000000000000000000000000000000000000000",
  srcChain: "ethereum",
  srcToken: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    chain: "ethereum",
  },
  srcAmount: "1000000",
  dstToken: {
    contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    symbol: "USDC",
    decimals: 7,
  },
  minDstAmount: "990000",
  deadline: Math.floor(Date.now() / 1000) + 3600,
};

/** Minimal repository double with a tunable write delay to widen the race window. */
class FakeIntentsRepository {
  readonly store = new Map<string, Intent>();
  saveCalls = 0;
  saveDelayMs = 0;
  failNextSave = false;

  async save(intent: Intent): Promise<Intent> {
    this.saveCalls += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("simulated persistence failure");
    }
    if (this.saveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.saveDelayMs));
    }
    this.store.set(intent.intentId, intent);
    return intent;
  }

  async findById(id: string): Promise<Intent | undefined> {
    return this.store.get(id);
  }
}

interface Harness {
  service: IntentsService;
  repo: FakeIntentsRepository;
}

function buildService(onchain = false): Harness {
  const repo = new FakeIntentsRepository();

  const config = {
    get: (key: string) => {
      if (key === "onchainIntentsEnabled") return onchain;
      if (key === "stellar.settlementContractId") return "CONTRACT";
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;

  const stellarTx = {} as unknown as StellarTxService;
  const prisma = {} as unknown as PrismaService;

  const service = new IntentsService(
    repo as unknown as IIntentsRepository,
    config,
    stellarTx,
    prisma,
  );

  return { service, repo };
}

describe("IntentsService.create — idempotency race safety (#274)", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("creates exactly one intent for N concurrent calls with the same key", async () => {
    harness = buildService();
    harness.repo.saveDelayMs = 15; // widen the check-then-act window

    const results = await Promise.all(
      Array.from({ length: 25 }, () => harness.service.create(baseData, "same-key")),
    );

    expect(harness.repo.saveCalls).toBe(1);
    expect(harness.repo.store.size).toBe(1);
    expect(new Set(results.map((r) => r.intentId)).size).toBe(1);
  });

  it("returns the first result to every racing caller", async () => {
    harness = buildService();
    harness.repo.saveDelayMs = 10;

    const [first, ...rest] = await Promise.all(
      Array.from({ length: 10 }, () => harness.service.create(baseData, "key-a")),
    );

    for (const other of rest) {
      expect(other).toEqual(first);
    }
  });

  it("replays the cached intent for a sequential repeat of the same key", async () => {
    harness = buildService();

    const first = await harness.service.create(baseData, "key-b");
    const second = await harness.service.create(baseData, "key-b");

    expect(second.intentId).toBe(first.intentId);
    expect(harness.repo.saveCalls).toBe(1);
  });

  it("does not deduplicate calls that omit an idempotency key", async () => {
    harness = buildService();
    harness.repo.saveDelayMs = 10;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => harness.service.create(baseData)),
    );

    expect(harness.repo.saveCalls).toBe(5);
    expect(new Set(results.map((r) => r.intentId)).size).toBe(5);
  });

  it("keeps distinct keys independent", async () => {
    harness = buildService();
    harness.repo.saveDelayMs = 10;

    await Promise.all([
      harness.service.create(baseData, "key-1"),
      harness.service.create(baseData, "key-2"),
      harness.service.create(baseData, "key-1"),
      harness.service.create(baseData, "key-2"),
    ]);

    expect(harness.repo.saveCalls).toBe(2);
  });

  it("releases the in-flight claim on failure so a later retry succeeds", async () => {
    harness = buildService();
    harness.repo.failNextSave = true;

    await expect(harness.service.create(baseData, "key-retry")).rejects.toThrow(
      "simulated persistence failure",
    );

    const intent = await harness.service.create(baseData, "key-retry");
    expect(intent.intentId).toBeDefined();
    expect(harness.repo.store.size).toBe(1);
  });

  it("claims the key before the on-chain registration await", async () => {
    harness = buildService(true);
    const registerSpy = jest
      .spyOn(
        harness.service as unknown as { registerOnChain: (intent: Intent) => Promise<void> },
        "registerOnChain",
      )
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

    await Promise.all(
      Array.from({ length: 8 }, () => harness.service.create(baseData, "key-onchain")),
    );

    // If the claim were taken after registerOnChain()'s await, several racers
    // would each reach the on-chain call before the first cache write landed.
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(harness.repo.saveCalls).toBe(1);
  });
});
