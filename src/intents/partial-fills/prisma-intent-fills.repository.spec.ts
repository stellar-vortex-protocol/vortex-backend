/**
 * PrismaIntentFillsRepository against a real Postgres (issue #427).
 *
 * The in-memory adapter's lock is a promise chain; the Postgres adapter's is
 * `SELECT … FOR UPDATE` on the parent intent. Only a real database can prove
 * the latter, so this suite runs when INTEGRATION_DATABASE_URL points at a
 * migrated database and is skipped otherwise:
 *
 *   INTEGRATION_DATABASE_URL=postgresql://vortex:vortex@localhost:5432/vortex npx jest prisma-intent-fills
 */
import { v4 as uuidv4 } from "uuid";
import { PrismaService } from "../../prisma/prisma.service";
import { allocation } from "./partial-fill.math";
import { PrismaIntentFillsRepository } from "./prisma-intent-fills.repository";

const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("PrismaIntentFillsRepository (Postgres)", () => {
  let prisma: PrismaService;
  let repo: PrismaIntentFillsRepository;
  const now = 1_900_000_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    await prisma.$connect();
    repo = new PrismaIntentFillsRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function openIntent(srcAmount = "1000"): Promise<string> {
    const intentId = uuidv4();
    await prisma.intent.create({
      data: {
        intentId,
        user: "GUSER",
        srcChain: "stellar",
        srcToken: {},
        srcAmount,
        dstToken: {},
        minDstAmount: "900",
        state: "open",
        createdAt: now,
        deadline: now + 3600,
        allowPartialFill: true,
        minFillAmount: "1",
      },
    });
    return intentId;
  }

  const request = (intentId: string, solver: string, amount: string) => ({
    intentId,
    srcAmount: "1000",
    minDstAmount: "900",
    minFillAmount: "1",
    solver,
    amount,
    deadline: now + 600,
    now,
  });

  it("serialises 10 concurrent reservations under the intent row lock", async () => {
    const intentId = await openIntent();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.reserve(request(intentId, `S${i}`, "150"), () => true)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    const { reserved, remaining } = allocation("1000", await repo.listByIntent(intentId));
    expect(reserved).toBe(900n);
    expect(remaining).toBe(100n);
  });

  it("holds Σ ≤ srcAmount for random concurrent sizes", async () => {
    for (let run = 0; run < 5; run++) {
      const intentId = await openIntent();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.reserve(request(intentId, `S${i}`, String(1 + Math.floor(Math.random() * 400))), () => true),
        ),
      );
      const { reserved } = allocation("1000", await repo.listByIntent(intentId));
      expect(reserved <= 1000n).toBe(true);
    }
  });

  it("refuses to reserve on an intent that is not open", async () => {
    const intentId = await openIntent();
    await prisma.intent.update({ where: { intentId }, data: { state: "cancelled" } });
    await expect(repo.reserve(request(intentId, "S", "10"), () => true)).resolves.toMatchObject({
      ok: false,
      reason: "intent_not_open",
    });
  });

  it("fill and slash are exclusive conditional writes", async () => {
    const intentId = await openIntent();
    const reserved = await repo.reserve(request(intentId, "S", "100"), () => true);
    if (!reserved.ok) throw new Error("reserve failed");
    const { fillId, deadline } = reserved.fill;

    expect(await repo.markSlashed(fillId, deadline - 1)).toBeNull(); // window still open
    expect(await repo.markFilled(fillId, "OTHER", { dstAmount: "90", feeAmount: "0", filledAt: now })).toBeNull();
    const filled = await repo.markFilled(fillId, "S", { dstAmount: "90", feeAmount: "0", filledAt: now + 1 });
    expect(filled).toMatchObject({ status: "filled", dstAmount: "90" });
    expect(await repo.markSlashed(fillId, deadline + 1)).toBeNull(); // fill won
    expect(await repo.findExpiredReservations(deadline + 1)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fillId })]),
    );
  });
});
