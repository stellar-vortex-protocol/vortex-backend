import { InMemoryOutboxRepository, NewOutboxEntry } from "./outbox.repository";

const at = (ms: number) => new Date(1_700_000_000_000 + ms);
const entry = (intentId: string, operation: NewOutboxEntry["operation"] = "create_intent"): NewOutboxEntry => ({
  intentId,
  operation,
  payload: { intentId },
});

describe("InMemoryOutboxRepository (#396)", () => {
  let repo: InMemoryOutboxRepository;

  beforeEach(() => {
    repo = new InMemoryOutboxRepository();
  });

  it("assigns monotonic ids and starts rows as pending with zero attempts", async () => {
    const a = await repo.enqueue(entry("i1"));
    const b = await repo.enqueue(entry("i1", "accept_intent"));
    expect(BigInt(b.id)).toBeGreaterThan(BigInt(a.id));
    expect(a).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("claims only the head row per intent, but runs different intents in parallel", async () => {
    await repo.enqueue(entry("i1"));
    await repo.enqueue(entry("i1", "accept_intent"));
    await repo.enqueue(entry("i2"));

    const claimed = await repo.claimDue(new Date(Date.now() + 1000), 10, at(60_000));

    expect(claimed.map((r) => [r.intentId, r.operation])).toEqual([
      ["i1", "create_intent"],
      ["i2", "create_intent"],
    ]);
    expect(claimed.every((r) => r.status === "processing" && r.attempts === 1)).toBe(true);
  });

  it("releases the next row for an intent only once the previous one is confirmed or simulated", async () => {
    await repo.enqueue(entry("i1"));
    await repo.enqueue(entry("i1", "accept_intent"));
    const now = new Date(Date.now() + 1000);

    const [first] = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    await repo.markSubmitted(first, "tx1");
    expect(await repo.claimDue(now, 10, new Date(now.getTime() + 60_000))).toEqual([]);

    await repo.markConfirmed({ ...first }, "tx1");
    const [second] = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    expect(second.operation).toBe("accept_intent");

    await repo.markSimulated(second);
    await repo.enqueue(entry("i1", "fill_intent"));
    const [third] = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    expect(third.operation).toBe("fill_intent");
  });

  it("respects the batch limit and nextAttemptAt", async () => {
    await repo.enqueue(entry("i1"));
    await repo.enqueue(entry("i2"));
    const now = new Date(Date.now() + 1000);
    const [claimed] = await repo.claimDue(now, 1, new Date(now.getTime() + 60_000));
    expect(claimed.intentId).toBe("i1");

    await repo.scheduleRetry(claimed, "boom", new Date(now.getTime() + 10_000));
    const next = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    expect(next.map((r) => r.intentId)).toEqual(["i2"]);
    const later = await repo.claimDue(new Date(now.getTime() + 10_001), 10, new Date(now.getTime() + 70_000));
    expect(later.map((r) => r.intentId)).toEqual(["i1"]);
    expect(later[0].attempts).toBe(2);
  });

  it("reclaims a processing row only after its lease expires (crashed worker)", async () => {
    await repo.enqueue(entry("i1"));
    const now = new Date(Date.now() + 1000);
    const leaseUntil = new Date(now.getTime() + 60_000);
    await repo.claimDue(now, 10, leaseUntil);

    expect(await repo.claimDue(new Date(leaseUntil.getTime() - 1), 10, at(0))).toEqual([]);
    const [reclaimed] = await repo.claimDue(new Date(leaseUntil.getTime() + 1), 10, at(0));
    expect(reclaimed.attempts).toBe(2);
  });

  it("fences writes on attempts so a stale worker cannot overwrite a reclaimed row", async () => {
    await repo.enqueue(entry("i1"));
    const now = new Date(Date.now() + 1000);
    const [stale] = await repo.claimDue(now, 10, new Date(now.getTime() + 1));
    const [fresh] = await repo.claimDue(new Date(now.getTime() + 2), 10, new Date(now.getTime() + 60_000));

    expect(await repo.recordEnvelope(stale, "old")).toBe(false);
    expect(await repo.markSubmitted(stale, "old")).toBe(false);
    expect(await repo.recordEnvelope(fresh, "new")).toBe(true);
    expect((await repo.findByIntent("i1"))[0].envelopeHash).toBe("new");
  });

  it("clears envelope and tx hash on retry so the relay rebuilds", async () => {
    await repo.enqueue(entry("i1"));
    const now = new Date(Date.now() + 1000);
    const [row] = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    await repo.recordEnvelope(row, "h");
    await repo.markSubmitted(row, "h");
    await repo.scheduleRetry(row, "failed on-chain", now);

    const [stored] = await repo.findByIntent("i1");
    expect(stored).toMatchObject({ status: "pending", lastError: "failed on-chain" });
    expect(stored.envelopeHash).toBeUndefined();
    expect(stored.txHash).toBeUndefined();
  });

  it("dead rows block later rows for the same intent until requeued", async () => {
    await repo.enqueue(entry("i1"));
    await repo.enqueue(entry("i1", "accept_intent"));
    const now = new Date(Date.now() + 1000);
    const [row] = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    await repo.markDead(row, "poison");

    expect(await repo.claimDue(now, 10, new Date(now.getTime() + 60_000))).toEqual([]);
    expect((await repo.countByStatus()).dead).toBe(1);

    expect(await repo.requeueDead("999")).toBe(false);
    expect(await repo.requeueDead(row.id)).toBe(true);
    expect(await repo.requeueDead(row.id)).toBe(false);
    const [again] = await repo.claimDue(new Date(Date.now() + 1000), 10, at(0));
    expect(again).toMatchObject({ id: row.id, attempts: 1, operation: "create_intent" });
  });

  it("lists submitted rows oldest first and counts by status", async () => {
    await repo.enqueue(entry("i1"));
    await repo.enqueue(entry("i2"));
    const now = new Date(Date.now() + 1000);
    const [a, b] = await repo.claimDue(now, 10, new Date(now.getTime() + 60_000));
    await repo.markSubmitted(b, "tb");
    await repo.markSubmitted(a, "ta");

    expect((await repo.findSubmitted(10)).map((r) => r.txHash)).toEqual(["ta", "tb"]);
    expect((await repo.findSubmitted(1)).map((r) => r.txHash)).toEqual(["ta"]);
    expect(await repo.countByStatus()).toEqual({
      pending: 0,
      processing: 0,
      submitted: 2,
      confirmed: 0,
      simulated: 0,
      dead: 0,
    });
  });
});
