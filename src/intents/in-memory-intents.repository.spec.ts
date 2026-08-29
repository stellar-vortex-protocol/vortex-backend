import { InMemoryIntentsRepository } from "./intents.repository";
import { Intent } from "./intents.types";

/** Minimal helper that builds a valid Intent for test cases. */
function makeIntent(overrides: Partial<Intent> = {}): Intent {
  const now = Math.floor(Date.now() / 1000);
  return {
    intentId: "test-id-1",
    user: "GUSER...0001",
    srcChain: "ethereum",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "990000",
    state: "open",
    createdAt: now,
    deadline: now + 1800,
    ...overrides,
  };
}

describe("InMemoryIntentsRepository", () => {
  let repo: InMemoryIntentsRepository;

  beforeEach(() => {
    repo = new InMemoryIntentsRepository();
  });

  // ── seed ──────────────────────────────────────────────────────────────────

  it("seeds 5 intents on construction", () => {
    expect(repo.findAll()).toHaveLength(5);
  });

  // ── save ──────────────────────────────────────────────────────────────────

  it("save persists and returns the intent", () => {
    const intent = makeIntent({ intentId: "save-test" });
    const saved = repo.save(intent);

    expect(saved).toEqual(intent);
    expect(repo.findById("save-test")).toEqual(intent);
  });

  it("save with the same intentId overwrites the existing record", () => {
    const intent = makeIntent({ intentId: "dup-id", state: "open" });
    repo.save(intent);
    repo.save({ ...intent, state: "cancelled" });

    expect(repo.findById("dup-id")?.state).toBe("cancelled");
    // Still only one record with that id
    expect(repo.findAll().filter((i) => i.intentId === "dup-id")).toHaveLength(1);
  });

  // ── findById ──────────────────────────────────────────────────────────────

  it("findById returns undefined for a missing id", () => {
    expect(repo.findById("nope")).toBeUndefined();
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  it("findAll returns intents sorted by createdAt descending", () => {
    const now = Math.floor(Date.now() / 1000);
    repo.save(makeIntent({ intentId: "old", createdAt: now - 100 }));
    repo.save(makeIntent({ intentId: "new", createdAt: now + 100 }));

    const all = repo.findAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }
  });

  // ── findByState ───────────────────────────────────────────────────────────

  it("findByState returns only intents matching that state", () => {
    repo.save(makeIntent({ intentId: "a1", state: "open" }));
    repo.save(makeIntent({ intentId: "a2", state: "filled" }));
    repo.save(makeIntent({ intentId: "a3", state: "open" }));

    const open = repo.findByState("open");
    expect(open.every((i) => i.state === "open")).toBe(true);
    expect(open.some((i) => i.intentId === "a1")).toBe(true);
    expect(open.some((i) => i.intentId === "a3")).toBe(true);
    expect(open.some((i) => i.intentId === "a2")).toBe(false);
  });

  it("findByState returns an empty array when no intents match", () => {
    expect(repo.findByState("slashed")).toHaveLength(0);
  });

  // ── findByUser ────────────────────────────────────────────────────────────

  it("findByUser is case-insensitive", () => {
    repo.save(makeIntent({ intentId: "u1", user: "GADDR...UPPER" }));

    const found = repo.findByUser("gaddr...upper");
    expect(found.some((i) => i.intentId === "u1")).toBe(true);
  });

  it("findByUser returns only that user's intents", () => {
    repo.save(makeIntent({ intentId: "u1", user: "USER_A" }));
    repo.save(makeIntent({ intentId: "u2", user: "USER_B" }));

    const result = repo.findByUser("USER_A");
    expect(result.every((i) => i.user === "USER_A")).toBe(true);
    expect(result.some((i) => i.intentId === "u2")).toBe(false);
  });

  // ── update ────────────────────────────────────────────────────────────────

  it("update applies patch and returns the updated intent", () => {
    repo.save(makeIntent({ intentId: "upd-1", state: "open" }));

    const updated = repo.update("upd-1", { state: "accepted", solver: "SOLVER_X" });

    expect(updated?.state).toBe("accepted");
    expect(updated?.solver).toBe("SOLVER_X");
    expect(repo.findById("upd-1")?.state).toBe("accepted");
  });

  it("update does not mutate unrelated fields", () => {
    const intent = makeIntent({ intentId: "upd-2", srcAmount: "999" });
    repo.save(intent);

    repo.update("upd-2", { state: "cancelled" });

    expect(repo.findById("upd-2")?.srcAmount).toBe("999");
  });

  it("update returns null for a missing id", () => {
    expect(repo.update("nope", { state: "cancelled" })).toBeNull();
  });
});
