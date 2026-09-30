import {
  EVALUATION_ORDER,
  candidateOperations,
  evaluate,
  scopeMatches,
} from "./killswitch.evaluate";
import { ALLOW_ALL, SwitchSnapshotEntry } from "./killswitch.types";

function entry(partial: Partial<SwitchSnapshotEntry> & { scope: SwitchSnapshotEntry["scope"] }): SwitchSnapshotEntry {
  return {
    chain: null,
    token: null,
    operation: null,
    active: true,
    reasonCode: "INCIDENT",
    reason: "test incident",
    activatedBy: "op1",
    updatedAt: 1_000,
    ...partial,
  };
}

describe("candidateOperations", () => {
  it("gates fill and slash on the onchain umbrella as well as their own name", () => {
    expect(candidateOperations("fill")).toEqual(["fill", "onchain"]);
    expect(candidateOperations("slash")).toEqual(["slash", "onchain"]);
  });

  it("does not add the onchain umbrella to database-only operations", () => {
    // Pausing all settlement must not also stop quoting new intents.
    expect(candidateOperations("create")).toEqual(["create"]);
    expect(candidateOperations("accept")).toEqual(["accept"]);
  });
});

describe("scopeMatches", () => {
  const candidates = ["fill", "onchain"] as const;

  it("global matches every request regardless of chain or token", () => {
    const global = entry({ scope: "global" });
    expect(scopeMatches(global, "global", { chain: "base", token: "USDC" }, candidates)).toBe(true);
    expect(scopeMatches(global, "global", { chain: null, token: null }, candidates)).toBe(true);
  });

  it("chain matches only its own chain", () => {
    const stellar = entry({ scope: "chain", chain: "stellar" });
    expect(scopeMatches(stellar, "chain", { chain: "stellar", token: "USDC" }, candidates)).toBe(true);
    expect(scopeMatches(stellar, "chain", { chain: "base", token: "USDC" }, candidates)).toBe(false);
  });

  it("token matches its own token, and a null token acts as a wildcard", () => {
    const specific = entry({ scope: "token", chain: "stellar", token: "USDC" });
    expect(scopeMatches(specific, "token", { chain: "stellar", token: "USDC" }, candidates)).toBe(true);
    expect(scopeMatches(specific, "token", { chain: "stellar", token: "DAI" }, candidates)).toBe(false);
    expect(scopeMatches(specific, "token", { chain: "base", token: "USDC" }, candidates)).toBe(false);

    const wildcard = entry({ scope: "token", chain: "stellar", token: null });
    expect(scopeMatches(wildcard, "token", { chain: "stellar", token: "DAI" }, candidates)).toBe(true);
  });

  it("operation matches only when the operation is in the candidate set", () => {
    const onchain = entry({ scope: "operation", chain: "stellar", operation: "onchain" });
    expect(scopeMatches(onchain, "operation", { chain: "stellar" }, candidates)).toBe(true);

    const createSwitch = entry({ scope: "operation", chain: "stellar", operation: "create" });
    expect(scopeMatches(createSwitch, "operation", { chain: "stellar" }, candidates)).toBe(false);
  });

  it("operation honours a wildcard token", () => {
    const wildcard = entry({ scope: "operation", chain: "stellar", token: null, operation: "fill" });
    expect(scopeMatches(wildcard, "operation", { chain: "stellar", token: "DAI" }, candidates)).toBe(true);
  });
});

describe("evaluate", () => {
  it("allows everything when no switches exist", () => {
    expect(evaluate([], { chain: "stellar", token: "USDC", operation: "fill" })).toEqual(ALLOW_ALL);
  });

  it("blocks on an active global switch", () => {
    const decision = evaluate([entry({ scope: "global" })], {
      chain: "base",
      token: "DAI",
      operation: "create",
    });
    expect(decision.paused).toBe(true);
  });

  it("blocks only the matching chain", () => {
    const switches = [entry({ scope: "chain", chain: "stellar", reasonCode: "CHAIN_DEGRADED" })];
    expect(evaluate(switches, { chain: "stellar", token: null, operation: "fill" }).paused).toBe(true);
    expect(evaluate(switches, { chain: "base", token: null, operation: "fill" }).paused).toBe(false);
  });

  it("blocks only the matching token on a chain", () => {
    const switches = [entry({ scope: "token", chain: "stellar", token: "USDC" })];
    expect(evaluate(switches, { chain: "stellar", token: "USDC", operation: "fill" }).paused).toBe(true);
    expect(evaluate(switches, { chain: "stellar", token: "DAI", operation: "fill" }).paused).toBe(false);
  });

  it("blocks only the matching operation", () => {
    const switches = [entry({ scope: "operation", chain: "stellar", operation: "slash" })];
    expect(evaluate(switches, { chain: "stellar", token: null, operation: "slash" }).paused).toBe(true);
    expect(evaluate(switches, { chain: "stellar", token: null, operation: "create" }).paused).toBe(false);
  });

  it("an onchain switch stops fills and slashes but not creates", () => {
    const switches = [entry({ scope: "operation", chain: "stellar", operation: "onchain" })];
    expect(evaluate(switches, { chain: "stellar", token: null, operation: "fill" }).paused).toBe(true);
    expect(evaluate(switches, { chain: "stellar", token: null, operation: "slash" }).paused).toBe(true);
    expect(evaluate(switches, { chain: "stellar", token: null, operation: "create" }).paused).toBe(false);
  });

  // ── the central safety property ────────────────────────────────────────────

  it("FAILS CLOSED: a narrower inactive switch cannot reopen a broader active pause", () => {
    const switches = [
      entry({ scope: "chain", chain: "stellar", active: true, reasonCode: "CHAIN_DEGRADED" }),
      // An operator previously "resumed" one operation on this chain.
      entry({ scope: "operation", chain: "stellar", operation: "fill", active: false }),
    ];

    const decision = evaluate(switches, { chain: "stellar", token: null, operation: "fill" });

    expect(decision.paused).toBe(true);
    // The reported reason is the narrowest *active* match, not the inactive one.
    expect(decision.matched?.scope).toBe("chain");
    expect(decision.matched?.reasonCode).toBe("CHAIN_DEGRADED");
  });

  it("stays blocked when any level in the chain is active", () => {
    const switches = [
      entry({ scope: "global", active: false }),
      entry({ scope: "chain", chain: "stellar", active: true }),
      entry({ scope: "token", chain: "stellar", token: "USDC", active: false }),
    ];
    expect(evaluate(switches, { chain: "stellar", token: "USDC", operation: "fill" }).paused).toBe(true);
  });

  it("allows once every level is inactive", () => {
    const switches = [
      entry({ scope: "global", active: false }),
      entry({ scope: "chain", chain: "stellar", active: false }),
    ];
    expect(evaluate(switches, { chain: "stellar", token: "USDC", operation: "fill" }).paused).toBe(false);
  });

  it("reports the most specific active match as the governing reason", () => {
    const switches = [
      entry({ scope: "global", active: true, reasonCode: "INCIDENT" }),
      entry({ scope: "chain", chain: "stellar", active: true, reasonCode: "CHAIN_DEGRADED" }),
      entry({ scope: "token", chain: "stellar", token: "USDC", active: true, reasonCode: "TOKEN_DEPEGGED" }),
    ];

    const decision = evaluate(switches, { chain: "stellar", token: "USDC", operation: "fill" });

    expect(decision.paused).toBe(true);
    expect(decision.matched?.reasonCode).toBe("TOKEN_DEPEGGED");
  });

  it("lists matched switches broadest-first", () => {
    const switches = [
      entry({ scope: "operation", chain: "stellar", token: "USDC", operation: "fill" }),
      entry({ scope: "global" }),
      entry({ scope: "chain", chain: "stellar" }),
    ];

    const decision = evaluate(switches, { chain: "stellar", token: "USDC", operation: "fill" });

    expect(decision.matchedChain.map((m) => m.scope)).toEqual([
      "global",
      "chain",
      "operation",
    ]);
  });

  it("evaluation order is broadest to narrowest", () => {
    expect([...EVALUATION_ORDER]).toEqual(["global", "chain", "token", "operation"]);
  });

  it("a global pause covers a request with no chain or token at all", () => {
    const switches = [entry({ scope: "global" })];
    const decision = evaluate(switches, { chain: null, token: null, operation: "onchain" });
    expect(decision.paused).toBe(true);
  });

  it("a chain switch cannot match a request with no chain", () => {
    const switches = [entry({ scope: "chain", chain: "stellar" })];
    expect(evaluate(switches, { chain: null, token: null, operation: "fill" }).paused).toBe(false);
  });
});
