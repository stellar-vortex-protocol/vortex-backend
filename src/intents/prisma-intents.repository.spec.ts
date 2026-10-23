import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { runIntentsRepositoryContract } from "./intents-repository.contract";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { InMemoryIntentsRepository } from "./intents.repository";
import { Intent } from "./intents.types";

/**
 * Runs the shared repository contract against a real Postgres (issue #404).
 *
 * Opt-in via TEST_DATABASE_URL so a developer's `DATABASE_URL` is never
 * written to by accident. CI points it at the migrated service container.
 */
const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describe("PrismaIntentsRepository.amendIfOpen", () => {
  it("guards the update by open state and the existing future deadline", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findUnique = jest.fn();
    const repo = new PrismaIntentsRepository({
      intent: { updateMany, findUnique },
    } as unknown as PrismaService);

    expect(
      await repo.amendIfOpen("intent-1", { minDstAmount: "900", deadline: 2_000 }, 1_000),
    ).toBeNull();
    expect(updateMany).toHaveBeenCalledWith({
      where: { intentId: "intent-1", state: "open", deadline: { gt: 1_000 } },
      data: { minDstAmount: "900", deadline: 2_000, deadlineTs: new Date(2_000_000) },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describeDb("PrismaIntentsRepository (Postgres)", () => {
  // Built lazily: describe.skip still evaluates this body, and PrismaClient
  // rejects an undefined URL at construction time.
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    // Contract rows use fresh UUIDs and a recognisable user prefix.
    await prisma.$executeRaw`DELETE FROM intents WHERE "user" LIKE 'GCONTRACTUSER%' OR "user" LIKE 'GUSER%' OR "user" = 'GMixedCaseUser'`;
    await prisma.$disconnect();
  });

  const pg = () => new PrismaIntentsRepository(prisma as unknown as PrismaService);

  runIntentsRepositoryContract("postgres", pg);
  // Issue #409: the same contract with reads switched to the timestamptz twins.
  // The contract reuses fixed tx hashes, so clear the previous run's rows first.
  describe("timestamptz reads", () => {
    beforeAll(async () => {
      await prisma.$executeRaw`DELETE FROM intents WHERE "user" LIKE 'GCONTRACTUSER%' OR "user" LIKE 'GUSER%' OR "user" = 'GMixedCaseUser'`;
    });
    runIntentsRepositoryContract(
      "postgres (TIMESTAMP_READ_SOURCE=timestamptz)",
      () => new PrismaIntentsRepository(prisma as unknown as PrismaService, { timestampReadSource: "timestamptz" }),
    );
    afterAll(async () => {
      await prisma.$executeRaw`DELETE FROM intents WHERE "user" LIKE 'GCONTRACTUSER%' OR "user" LIKE 'GUSER%' OR "user" = 'GMixedCaseUser'`;
    });
  });
  runIntentsRepositoryContract(
    "dual-write (memory + postgres)",
    () => new DualWriteIntentsRepository(new InMemoryIntentsRepository({ seed: false }), pg()),
  );

  it("saveIfNewer never regresses a row to an older version", async () => {
    const repo = pg();
    const now = Math.floor(Date.now() / 1000);
    const base: Intent = {
      intentId: `saveifnewer-${now}-${Math.random()}`,
      user: "GCONTRACTUSER_SAVEIFNEWER",
      srcChain: "base",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "base" },
      srcAmount: "1",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "1",
      state: "accepted",
      createdAt: now,
      deadline: now + 60,
      version: 2,
      srcVerified: true,
    };
    await repo.saveIfNewer(base);
    await repo.saveIfNewer({ ...base, state: "open", version: 1 }); // late, out-of-order mirror
    expect(await repo.findById(base.intentId)).toMatchObject({ state: "accepted", version: 2 });
    await repo.saveIfNewer({ ...base, state: "filled", version: 3 });
    expect(await repo.findById(base.intentId)).toMatchObject({ state: "filled", version: 3 });
  });
});
