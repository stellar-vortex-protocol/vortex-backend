import { InMemoryPendingSlashesRepository, NewPendingSlash } from "./pending-slashes.repository";
import { PrismaPendingSlashesRepository } from "./prisma-pending-slashes.repository";
import { PrismaService } from "../prisma/prisma.service";

const t = (s: number) => new Date(1_900_000_000_000 + s * 1000);
const input = (intentId = "i1"): NewPendingSlash => ({
  intentId,
  solverAddress: "GSOLVER",
  reason: "missed",
  fillDeadline: 1_899_999_990,
  detectedAt: t(0),
  challengeEndsAt: t(600),
});

describe("InMemoryPendingSlashesRepository (#397)", () => {
  let repo: InMemoryPendingSlashesRepository;
  beforeEach(() => (repo = new InMemoryPendingSlashesRepository()));

  it("enforces one slash per intent", async () => {
    const first = await repo.createIfAbsent(input());
    const second = await repo.createIfAbsent({ ...input(), reason: "dup" });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, slash: { id: first.slash.id, reason: "missed" } });
    expect(await repo.findByIntent("nope")).toBeUndefined();
  });

  it("finds due rows by state, window, backoff and lease", async () => {
    await repo.createIfAbsent(input("detected"));
    await repo.createIfAbsent(input("window"));
    await repo.transition("window", ["detected"], { state: "challenge_window" });
    await repo.createIfAbsent(input("sim"));
    await repo.transition("sim", ["detected"], { state: "submitted", simulated: true });
    await repo.createIfAbsent(input("live"));
    await repo.transition("live", ["detected"], { state: "submitted", simulated: false, nextAttemptAt: t(0) });

    expect((await repo.findDue(t(599), 10)).map((r) => r.intentId).sort()).toEqual(["detected", "live"]);
    expect((await repo.findDue(t(600), 10)).map((r) => r.intentId).sort()).toEqual(["detected", "live", "window"]);
    expect(await repo.findDue(t(600), 1)).toHaveLength(1);

    expect(await repo.claim("window", t(600), t(700))).toBe(true);
    expect(await repo.claim("window", t(650), t(750))).toBe(false);
    expect(await repo.claim("missing", t(650), t(750))).toBe(false);
    expect((await repo.findDue(t(650), 10)).map((r) => r.intentId)).not.toContain("window");
    expect((await repo.findDue(t(701), 10)).map((r) => r.intentId)).toContain("window");
  });

  it("transition is guarded by state and, when `now` is given, by the lease", async () => {
    await repo.createIfAbsent(input());
    expect(await repo.transition("i1", ["submitted"], { state: "confirmed" })).toBeNull();
    expect(await repo.transition("missing", ["detected"], {})).toBeNull();

    await repo.claim("i1", t(0), t(100));
    expect(await repo.transition("i1", ["detected"], { state: "cancelled" }, t(50))).toBeNull();
    const moved = await repo.transition("i1", ["detected"], { state: "challenge_window" });
    expect(moved).toMatchObject({ state: "challenge_window", lockedUntil: undefined });
  });

  it("lists newest first with an optional state filter", async () => {
    await repo.createIfAbsent(input("a"));
    await repo.createIfAbsent({ ...input("b"), detectedAt: t(10) });
    expect((await repo.list({ limit: 10 })).map((r) => r.intentId)).toEqual(["b", "a"]);
    expect(await repo.list({ state: "confirmed", limit: 10 })).toEqual([]);
  });
});

describe("PrismaPendingSlashesRepository (#397)", () => {
  const row = { ...input(), id: "s1", state: "detected", attempts: 0, nextAttemptAt: t(0), lockedUntil: null, txHash: null,
    simulated: false, submittedAt: null, confirmedAt: null, cancelledAt: null, cancelReason: null, cancelledBy: null,
    fillTxHash: null, lastError: null, createdAt: t(0), updatedAt: t(0) };
  let pendingSlash: Record<string, jest.Mock>;
  let repo: PrismaPendingSlashesRepository;

  beforeEach(() => {
    pendingSlash = {
      create: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    repo = new PrismaPendingSlashesRepository({ pendingSlash } as unknown as PrismaService);
  });

  it("maps a unique violation (P2002) to created=false and rethrows anything else", async () => {
    expect(await repo.createIfAbsent(input())).toMatchObject({ created: true, slash: { id: "s1", lockedUntil: undefined } });
    pendingSlash.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await repo.createIfAbsent(input())).toMatchObject({ created: false });
    pendingSlash.create.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "P1001" }));
    await expect(repo.createIfAbsent(input())).rejects.toThrow("down");
  });

  it("reads by intent and lists with filters", async () => {
    expect(await repo.findByIntent("i1")).toMatchObject({ intentId: "i1" });
    pendingSlash.findUnique.mockResolvedValueOnce(null);
    expect(await repo.findByIntent("x")).toBeUndefined();
    await repo.list({ state: "submitted", limit: 5 });
    expect(pendingSlash.findMany).toHaveBeenLastCalledWith({ where: { state: "submitted" }, orderBy: { detectedAt: "desc" }, take: 5 });
    await repo.list({ limit: 5 });
    expect(pendingSlash.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: undefined }));
  });

  it("queries due, unleased rows", async () => {
    await repo.findDue(t(1), 3);
    const args = pendingSlash.findMany.mock.calls[0][0];
    expect(JSON.stringify(args.where)).toContain("challenge_window");
    expect(args.take).toBe(3);
  });

  it("claims and transitions with conditional updates", async () => {
    expect(await repo.claim("i1", t(0), t(100))).toBe(true);
    expect(pendingSlash.updateMany).toHaveBeenLastCalledWith({
      where: { intentId: "i1", OR: [{ lockedUntil: null }, { lockedUntil: { lt: t(0) } }] },
      data: { lockedUntil: t(100) },
    });

    await repo.transition("i1", ["detected"], { state: "challenge_window", txHash: undefined }, t(5));
    expect(pendingSlash.updateMany).toHaveBeenLastCalledWith({
      where: { intentId: "i1", state: { in: ["detected"] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: t(5) } }] },
      data: { state: "challenge_window", lockedUntil: null },
    });

    pendingSlash.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.transition("i1", ["detected"], {})).toBeNull();
    pendingSlash.findUnique.mockResolvedValueOnce(null);
    expect(await repo.transition("i1", ["detected"], {})).toBeNull();
  });
});
