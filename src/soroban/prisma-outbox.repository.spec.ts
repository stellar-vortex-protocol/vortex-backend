import { Prisma } from "@prisma/client";
import { OutboxEntry } from "./outbox.repository";
import { OutboxPrismaClient, PrismaOutboxRepository } from "./prisma-outbox.repository";

const created = new Date("2026-09-27T00:00:00Z");
const modelRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7n,
  intentId: "i1",
  operation: "create_intent",
  payload: { intentId: "i1" },
  status: "pending",
  attempts: 0,
  nextAttemptAt: created,
  lockedUntil: null,
  envelopeHash: null,
  txHash: null,
  lastError: null,
  createdAt: created,
  updatedAt: created,
  ...overrides,
});

const entry = { id: "7", attempts: 2 } as OutboxEntry;

function fakeClient() {
  return {
    onchainOutbox: {
      create: jest.fn().mockResolvedValue(modelRow()),
      findMany: jest.fn().mockResolvedValue([modelRow({ status: "submitted", txHash: "h" })]),
      groupBy: jest.fn().mockResolvedValue([
        { status: "pending", _count: { _all: 3 } },
        { status: "dead", _count: { _all: 1 } },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn(),
  };
}

describe("PrismaOutboxRepository (#396)", () => {
  let client: ReturnType<typeof fakeClient>;
  let repo: PrismaOutboxRepository;

  beforeEach(() => {
    client = fakeClient();
    repo = new PrismaOutboxRepository(client as unknown as OutboxPrismaClient);
  });

  it("enqueues through the (transaction) client and maps bigint ids to strings", async () => {
    const row = await repo.enqueue({ intentId: "i1", operation: "create_intent", payload: { intentId: "i1" } });
    expect(client.onchainOutbox.create).toHaveBeenCalledWith({
      data: { intentId: "i1", operation: "create_intent", payload: { intentId: "i1" } },
    });
    expect(row).toMatchObject({ id: "7", status: "pending", lockedUntil: undefined, envelopeHash: undefined });
  });

  it("claims with a single SKIP LOCKED statement that enforces per-intent ordering", async () => {
    client.$queryRaw.mockResolvedValue([
      {
        id: 9n, intent_id: "b", operation: "create_intent", payload: {}, status: "processing", attempts: 1,
        next_attempt_at: created, locked_until: created, envelope_hash: null, tx_hash: null, last_error: null,
        created_at: created, updated_at: created,
      },
      {
        id: 3n, intent_id: "a", operation: "accept_intent", payload: null, status: "processing", attempts: 1,
        next_attempt_at: created, locked_until: created, envelope_hash: "e", tx_hash: null, last_error: "x",
        created_at: created, updated_at: created,
      },
    ]);
    const now = new Date("2026-09-27T01:00:00Z");
    const lease = new Date("2026-09-27T01:02:00Z");

    const rows = await repo.claimDue(now, 5, lease);

    const sql = client.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql.sql).toMatch(/NOT EXISTS/);
    expect(sql.sql).toMatch(/p\.id < c\.id/);
    expect(sql.sql).toMatch(/attempts = o\.attempts \+ 1/);
    expect(sql.values).toEqual(expect.arrayContaining([now, 5, lease, "confirmed", "simulated"]));
    expect(rows.map((r) => r.id)).toEqual(["3", "9"]);
    expect(rows[0]).toMatchObject({ intentId: "a", envelopeHash: "e", lastError: "x", payload: {} });
  });

  it("reads submitted rows, rows by intent, and status counts", async () => {
    expect(await repo.findSubmitted(4)).toHaveLength(1);
    expect(client.onchainOutbox.findMany).toHaveBeenLastCalledWith({
      where: { status: "submitted" },
      orderBy: { id: "asc" },
      take: 4,
    });
    await repo.findByIntent("i1");
    expect(client.onchainOutbox.findMany).toHaveBeenLastCalledWith({ where: { intentId: "i1" }, orderBy: { id: "asc" } });
    expect(await repo.countByStatus()).toEqual({
      pending: 3, processing: 0, submitted: 0, confirmed: 0, simulated: 0, dead: 1,
    });
  });

  it.each([
    ["recordEnvelope", () => repo.recordEnvelope(entry, "h"), ["processing"], { envelopeHash: "h" }],
    ["markSubmitted", () => repo.markSubmitted(entry, "h"), ["processing"], { status: "submitted", txHash: "h", lockedUntil: null }],
    ["markConfirmed", () => repo.markConfirmed(entry, "h"), ["processing", "submitted"], { status: "confirmed", txHash: "h", lockedUntil: null }],
    ["markSimulated", () => repo.markSimulated(entry), ["processing"], { status: "simulated", lockedUntil: null }],
    ["markDead", () => repo.markDead(entry, "e"), ["processing", "submitted"], { status: "dead", lastError: "e", lockedUntil: null }],
  ])("%s is fenced on id + attempts + status", async (_name, call, from, data) => {
    expect(await (call as () => Promise<boolean>)()).toBe(true);
    expect(client.onchainOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, attempts: 2, status: { in: from } },
      data,
    });
  });

  it("scheduleRetry clears the envelope so the relay rebuilds, and reports a lost fence", async () => {
    client.onchainOutbox.updateMany.mockResolvedValueOnce({ count: 0 });
    const next = new Date();
    expect(await repo.scheduleRetry(entry, "boom", next)).toBe(false);
    expect(client.onchainOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 7n, attempts: 2, status: { in: ["processing", "submitted"] } },
      data: { status: "pending", nextAttemptAt: next, lastError: "boom", lockedUntil: null, envelopeHash: null, txHash: null },
    });
  });

  it("requeues only dead rows", async () => {
    expect(await repo.requeueDead("7")).toBe(true);
    expect(client.onchainOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7n, status: "dead" } }),
    );
  });
});
