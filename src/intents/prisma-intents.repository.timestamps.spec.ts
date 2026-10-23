import { PrismaService } from "../prisma/prisma.service";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { Intent } from "./intents.types";
import { PrismaSolversRepository } from "../solvers/prisma-solvers.repository";
import { SolverRecord } from "../solvers/solvers.types";

/**
 * Issue #409 — the repositories write both the epoch INTEGER columns and their
 * timestamptz twins, and filter/sort/read on the column chosen by
 * TIMESTAMP_READ_SOURCE. The API keeps epoch seconds either way.
 */

const T = 1_700_000_000;
const d = (s: number) => new Date(s * 1000);

const intent: Intent = {
  intentId: "i-1",
  user: "GUSER",
  srcChain: "base",
  srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "base" },
  srcAmount: "1",
  dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
  minDstAmount: "1",
  state: "filled",
  createdAt: T,
  deadline: T + 600,
  filledAt: T + 300,
  version: 0,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "i-1",
    user: "GUSER",
    srcChain: "base",
    srcToken: {},
    srcAmount: "1",
    dstToken: {},
    minDstAmount: "1",
    auction: null,
    acceptedDstAmount: null,
    quotedDstAmount: null,
    solver: null,
    state: "open",
    createdAt: T,
    deadline: T + 600,
    filledAt: null,
    createdAtTs: d(T + 1),
    deadlineTs: d(T + 601),
    filledAtTs: null,
    fillAmount: null,
    txHash: null,
    version: 1,
    srcVerified: false,
    srcTxHash: null,
    srcVerification: null,
    ...overrides,
  };
}

function fakeIntentClient() {
  return {
    intent: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(row()),
      findMany: jest.fn().mockResolvedValue([row()]),
      count: jest.fn().mockResolvedValue(1),
    },
  };
}

describe("PrismaIntentsRepository timestamps (issue #409)", () => {
  it("dual-writes every epoch field on save", async () => {
    const client = fakeIntentClient();
    await new PrismaIntentsRepository(client as unknown as PrismaService).save(intent);
    expect(client.intent.upsert.mock.calls[0][0].create).toMatchObject({
      createdAt: T,
      createdAtTs: d(T),
      deadline: T + 600,
      deadlineTs: d(T + 600),
      filledAt: T + 300,
      filledAtTs: d(T + 300),
    });
  });

  it("dual-writes the deadline on accept and filledAt on fill", async () => {
    const client = fakeIntentClient();
    const repo = new PrismaIntentsRepository(client as unknown as PrismaService);

    await repo.acceptIfOpen("i-1", "GSOLVER", T + 900, T);
    await repo.fillIfAccepted("i-1", "GSOLVER", { filledAt: T + 10 }, T);
    await repo.update("i-1", { deadline: T + 5 });

    const [accept, fill, update] = client.intent.updateMany.mock.calls.map((c) => c[0]);
    expect(accept.data).toMatchObject({ deadline: T + 900, deadlineTs: d(T + 900) });
    expect(fill.data).toMatchObject({ filledAt: T + 10, filledAtTs: d(T + 10) });
    expect(update.data).toMatchObject({ deadline: T + 5, deadlineTs: d(T + 5) });
  });

  it("epoch mode filters, sorts and reads the INTEGER columns", async () => {
    const client = fakeIntentClient();
    const repo = new PrismaIntentsRepository(client as unknown as PrismaService);

    await repo.acceptIfOpen("i-1", "GSOLVER", T + 900, T);
    const found = await repo.search({ createdFrom: T - 1, createdTo: T + 1, sort: "deadline:asc" });

    expect(client.intent.updateMany.mock.calls[0][0].where).toMatchObject({ deadline: { gt: T } });
    expect(client.intent.findMany.mock.calls[0][0]).toMatchObject({
      where: { createdAt: { gte: T - 1, lte: T + 1 } },
      orderBy: { deadline: "asc" },
    });
    expect(found.intents[0]).toMatchObject({ createdAt: T, deadline: T + 600 });
  });

  it("timestamptz mode filters, sorts and reads the twins; the API stays in epoch seconds", async () => {
    const client = fakeIntentClient();
    const repo = new PrismaIntentsRepository(client as unknown as PrismaService, {
      timestampReadSource: "timestamptz",
    });

    await repo.acceptIfOpen("i-1", "GSOLVER", T + 900, T);
    const found = await repo.search({ createdFrom: T - 1 });
    const all = await repo.findAll();

    expect(client.intent.updateMany.mock.calls[0][0].where).toMatchObject({ deadlineTs: { gt: d(T) } });
    expect(client.intent.updateMany.mock.calls[0][0].where).not.toHaveProperty("deadline");
    expect(client.intent.findMany.mock.calls[0][0]).toMatchObject({
      where: { createdAtTs: { gte: d(T - 1) } },
      orderBy: { createdAtTs: "desc" },
    });
    expect(client.intent.findMany.mock.calls[1][0]).toMatchObject({ orderBy: { createdAtTs: "desc" } });
    expect(found.intents[0]).toMatchObject({ createdAt: T + 1, deadline: T + 601 });
    expect(typeof all[0].createdAt).toBe("number");
  });

  it("timestamptz mode falls back to the INTEGER value for a row the backfill has not reached", async () => {
    const client = fakeIntentClient();
    client.intent.findUnique.mockResolvedValue(row({ createdAtTs: null, deadlineTs: null }));
    const repo = new PrismaIntentsRepository(client as unknown as PrismaService, {
      timestampReadSource: "timestamptz",
    });
    expect(await repo.findById("i-1")).toMatchObject({ createdAt: T, deadline: T + 600 });
  });
});

describe("PrismaSolversRepository timestamps (issue #409)", () => {
  const solver: SolverRecord = {
    address: "GSOLVER",
    name: "s",
    bondAmount: "1",
    fillsCompleted: 0,
    fillsFailed: 0,
    totalVolume: "0",
    avgFillTime: 0,
    isActive: true,
    registeredAt: T,
    lastActiveAt: T + 60,
    supportedChains: [],
    supportedTokens: [],
  };
  const solverRow = {
    ...solver,
    registeredAtTs: d(T + 1),
    lastActiveAtTs: d(T + 61),
    source: "api",
    chainUpdatedLedger: null,
  };

  function fake() {
    return { solver: { upsert: jest.fn().mockResolvedValue(solverRow), findUnique: jest.fn().mockResolvedValue(solverRow) } };
  }

  it("dual-writes registeredAt and lastActiveAt", async () => {
    const client = fake();
    await new PrismaSolversRepository(client as unknown as PrismaService).save(solver);
    expect(client.solver.upsert.mock.calls[0][0].update).toMatchObject({
      registeredAt: T,
      registeredAtTs: d(T),
      lastActiveAt: T + 60,
      lastActiveAtTs: d(T + 60),
    });
  });

  it("reads the configured column", async () => {
    const epoch = await new PrismaSolversRepository(fake() as unknown as PrismaService).findByAddress("GSOLVER");
    const ts = await new PrismaSolversRepository(fake() as unknown as PrismaService, {
      timestampReadSource: "timestamptz",
    }).findByAddress("GSOLVER");
    expect(epoch).toMatchObject({ registeredAt: T, lastActiveAt: T + 60 });
    expect(ts).toMatchObject({ registeredAt: T + 1, lastActiveAt: T + 61 });
  });
});
