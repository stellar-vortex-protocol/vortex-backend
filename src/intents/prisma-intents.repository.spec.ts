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
