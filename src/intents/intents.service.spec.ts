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

  describe("acceptIfOpen", () => {
    it("transitions an open intent to accepted and returns it", () => {
      const [open] = service.getByState("open");
      const result = service.acceptIfOpen(open.intentId, "SOLVER_X");

      expect(result).not.toBeNull();
      expect(result!.state).toBe("accepted");
      expect(result!.solver).toBe("SOLVER_X");
      expect(service.get(open.intentId)!.state).toBe("accepted");
    });

    it("returns null for a non-existent intent", () => {
      expect(service.acceptIfOpen("does-not-exist", "SOLVER_X")).toBeNull();
    });

    it("returns null when the intent is already accepted", () => {
      const [accepted] = service.getByState("accepted");
      expect(service.acceptIfOpen(accepted.intentId, "SOLVER_X")).toBeNull();
    });

    it("only the first caller wins under simulated concurrency", () => {
      const [open] = service.getByState("open");
      const results = Array.from({ length: 10 }, (_, i) =>
        service.acceptIfOpen(open.intentId, `SOLVER_${i}`),
      );

      const successes = results.filter((r) => r !== null);
      expect(successes).toHaveLength(1);
      expect(successes[0]!.state).toBe("accepted");
    });
  });

  describe("fillIfAccepted", () => {
    it("transitions an accepted intent to filled when solver matches", () => {
      const [accepted] = service.getByState("accepted");
      const result = service.fillIfAccepted(accepted.intentId, accepted.solver!, {
        fillAmount: "100",
        txHash: "test-hash",
        filledAt: Math.floor(Date.now() / 1000),
      });

      expect(result).not.toBeNull();
      expect(result!.state).toBe("filled");
      expect(result!.fillAmount).toBe("100");
    });

    it("returns null when solver does not match", () => {
      const [accepted] = service.getByState("accepted");
      const result = service.fillIfAccepted(accepted.intentId, "WRONG_SOLVER", {
        fillAmount: "100",
      });
      expect(result).toBeNull();
    });

    it("returns null for a non-existent intent", () => {
      expect(service.fillIfAccepted("nope", "SOLVER_X", {})).toBeNull();
    });

    it("only the first caller wins under simulated concurrency", () => {
      const [accepted] = service.getByState("accepted");
      const results = Array.from({ length: 10 }, () =>
        service.fillIfAccepted(accepted.intentId, accepted.solver!, {
          fillAmount: "100",
          txHash: "race-hash",
          filledAt: Math.floor(Date.now() / 1000),
        }),
      );

      const successes = results.filter((r) => r !== null);
      expect(successes).toHaveLength(1);
      expect(successes[0]!.state).toBe("filled");
    });
  });
});
