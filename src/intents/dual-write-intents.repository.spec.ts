import { v4 as uuidv4 } from "uuid";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { InMemoryIntentsRepository, isVersionConflict } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { Intent } from "./intents.types";
import { MetricsService } from "../metrics/metrics.service";
import { runIntentsRepositoryContract } from "./intents-repository.contract";

/**
 * In-memory stand-in for the Postgres adapter, including saveIfNewer()'s
 * version guard, so the dual-write logic is testable without a database.
 * prisma-intents.repository.spec.ts covers the real Postgres pairing.
 */
class FakeSecondary extends InMemoryIntentsRepository {
  failWrites = false;

  constructor() {
    super({ seed: false });
  }

  async saveIfNewer(intent: Intent): Promise<void> {
    if (this.failWrites) throw new Error("postgres unavailable");
    const current = this.findById(intent.intentId);
    if (!current || current.version < intent.version) this.save(intent);
  }

  override createIdempotent(intent: Intent, key: string, minCreatedAt: number) {
    if (this.failWrites) throw new Error("postgres unavailable");
    return super.createIdempotent(intent, key, minCreatedAt);
  }
}

function build(metrics?: Partial<MetricsService>) {
  const primary = new InMemoryIntentsRepository({ seed: false });
  const secondary = new FakeSecondary();
  const repo = new DualWriteIntentsRepository(
    primary,
    secondary as unknown as PrismaIntentsRepository,
    metrics as MetricsService | undefined,
  );
  return { primary, secondary, repo };
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  const now = Math.floor(Date.now() / 1000);
  return {
    intentId: uuidv4(),
    user: "GDUALUSER",
    srcChain: "ethereum",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: now,
    deadline: now + 1800,
    version: 0,
    srcVerified: true,
    ...overrides,
  };
}

runIntentsRepositoryContract("dual-write (memory + fake secondary)", () => build().repo);

describe("DualWriteIntentsRepository", () => {
  it("mirrors every successful mutation to the secondary store", async () => {
    const { repo, secondary } = build();
    const intent = await repo.save(makeIntent());

    await repo.acceptIfOpen(intent.intentId, "GSOLVER", intent.deadline);
    await repo.fillIfAccepted(intent.intentId, "GSOLVER", { fillAmount: "995000" });

    expect(secondary.findById(intent.intentId)).toMatchObject({ state: "filled", version: 2, fillAmount: "995000" });
  });

  it("does not mirror version conflicts or failed state guards", async () => {
    const { repo, secondary } = build();
    const intent = await repo.save(makeIntent());
    const spy = jest.spyOn(secondary, "saveIfNewer");

    expect(isVersionConflict(await repo.cancelIfOpen(intent.intentId, 99))).toBe(true);
    expect(await repo.slashIfAccepted(intent.intentId, { slashedAt: 1, slashReason: "x" })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads come from memory even when the secondary disagrees", async () => {
    const { repo, secondary } = build();
    const intent = await repo.save(makeIntent());
    secondary.save({ ...intent, state: "cancelled" });

    expect(repo.findById(intent.intentId)?.state).toBe("open");
    expect(repo.findByState("open").map((i) => i.intentId)).toContain(intent.intentId);
  });

  it("counts mirror failures without failing the caller", async () => {
    const recordDualWriteFailure = jest.fn();
    const { repo, secondary } = build({ recordDualWriteFailure });
    const intent = await repo.save(makeIntent());
    secondary.failWrites = true;

    const accepted = await repo.acceptIfOpen(intent.intentId, "GSOLVER", intent.deadline);
    await repo.createIdempotent(makeIntent(), "key-1", 0);

    expect(accepted).toMatchObject({ state: "accepted" });
    expect(recordDualWriteFailure).toHaveBeenCalledWith("acceptIfOpen");
    expect(recordDualWriteFailure).toHaveBeenCalledWith("createIdempotent");
  });

  it("deletes from memory only, keeping Postgres as durable history", async () => {
    const { repo, secondary } = build();
    const intent = await repo.save(makeIntent());
    expect(repo.delete(intent.intentId)).toBe(true);
    expect(secondary.findById(intent.intentId)).toBeDefined();
  });

  describe("backfill", () => {
    it("hydrates memory from Postgres and pushes memory-only rows", async () => {
      const { repo, primary, secondary } = build();
      const dbOnly = secondary.save(makeIntent({ version: 3 }));
      const memoryOnly = primary.save(makeIntent());
      const stale = makeIntent({ version: 1 });
      primary.save(stale);
      secondary.save({ ...stale, version: 4, state: "cancelled" });

      const result = await repo.backfill();

      expect(result).toEqual({ loadedFromPostgres: 2, pushedToPostgres: 1 });
      expect(primary.findById(dbOnly.intentId)).toEqual(dbOnly);
      expect(primary.findById(stale.intentId)).toMatchObject({ version: 4, state: "cancelled" });
      expect(secondary.findById(memoryOnly.intentId)).toEqual(memoryOnly);
    });
  });
});
