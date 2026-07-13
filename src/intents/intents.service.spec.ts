import { IntentsService } from "./intents.service";

describe("IntentsService", () => {
  let service: IntentsService;

  beforeEach(() => {
    service = new IntentsService();
  });

  it("seeds 5 intents on construction", () => {
    expect(service.getAll()).toHaveLength(5);
  });

  it("getAll returns intents sorted by createdAt descending", () => {
    const all = service.getAll();
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }
  });

  it("create adds an open intent with a generated id", () => {
    const before = service.getAll().length;
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const intent = service.create({
      user: "GTEST...0000",
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline,
    });

    expect(intent.state).toBe("open");
    expect(intent.intentId).toBeTruthy();
    expect(intent.deadline).toBe(deadline);
    expect(service.getAll()).toHaveLength(before + 1);
  });

  it("get returns undefined for an unknown id", () => {
    expect(service.get("does-not-exist")).toBeUndefined();
  });

  it("update mutates and returns the patched intent", () => {
    const [existing] = service.getByState("open");
    const updated = service.update(existing.intentId, { state: "accepted", solver: "SOLVER_X" });

    expect(updated?.state).toBe("accepted");
    expect(updated?.solver).toBe("SOLVER_X");
    expect(service.get(existing.intentId)?.state).toBe("accepted");
  });

  it("update returns null for an unknown id", () => {
    expect(service.update("does-not-exist", { state: "cancelled" })).toBeNull();
  });

  it("getByUser is case-insensitive", () => {
    const [existing] = service.getAll();
    // seed data users are already uppercase, so lowercase actually exercises the transform
    const found = service.getByUser(existing.user.toLowerCase());
    expect(found.some((i) => i.intentId === existing.intentId)).toBe(true);
  });

  it("getByState only returns intents in that state", () => {
    for (const intent of service.getByState("filled")) {
      expect(intent.state).toBe("filled");
    }
  });
});
