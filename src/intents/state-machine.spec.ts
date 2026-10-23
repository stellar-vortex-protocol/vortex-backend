import {
  assertTransition,
  canTransition,
  DB_ALLOWED_TRANSITIONS,
  findRule,
  IllegalTransitionError,
  isTerminalState,
  requiresOverride,
  TRANSITION_TABLE,
  transition,
  TRANSITIONS,
} from "./state-machine";
import { INTENT_STATES, IntentState } from "./intents.types";

describe("intent state machine (TLA+ traceability — formal/IntentLifecycle.tla)", () => {
  it("allows exactly the specified legal transitions", () => {
    expect(canTransition("open", "accepted")).toBe(true);
    expect(canTransition("open", "cancelled")).toBe(true);
    expect(canTransition("open", "expired")).toBe(true);
    expect(canTransition("accepted", "filled")).toBe(true);
    expect(canTransition("accepted", "slashed")).toBe(true);
  });

  it("regression: fill confirms after sweeper slashes is rejected (no double terminal)", () => {
    // Counterexample class from TLC: fill and slash racing on `accepted`.
    // Whichever conditional write wins, the loser must observe a guard
    // failure — modelled here as the loser attempting a transition out of
    // a terminal state.
    expect(canTransition("filled", "slashed")).toBe(false);
    expect(canTransition("slashed", "filled")).toBe(false);
    expect(() => assertTransition("filled", "slashed")).toThrow(/Illegal intent transition/);
  });

  it("regression: never slash a filled intent", () => {
    expect(canTransition("filled", "slashed")).toBe(false);
  });

  it("terminal states are sinks", () => {
    for (const s of ["filled", "cancelled", "expired", "slashed"] as const) {
      expect(isTerminalState(s)).toBe(true);
      expect(TRANSITIONS[s]).toHaveLength(0);
    }
    expect(isTerminalState("open")).toBe(false);
    expect(isTerminalState("accepted")).toBe(false);
  });
});

// ── Issue #406: declarative table, pure transition(), exhaustive pair matrix ──

/**
 * Hand-written expectation, deliberately NOT derived from TRANSITION_TABLE so a
 * stray edit to the table fails here. Value = edge kind; absent = illegal.
 */
const EXPECTED: Partial<Record<`${IntentState}->${IntentState}`, string>> = {
  "open->accepted": "lifecycle",
  "open->cancelled": "lifecycle",
  "open->expired": "lifecycle",
  "accepted->filled": "lifecycle",
  "accepted->slashed": "lifecycle",
  "open->pending_open": "park",
  "open->pending_accepted": "park",
  "open->pending_cancelled": "park",
  "accepted->pending_accepted": "park",
  "accepted->pending_filled": "park",
  "accepted->pending_cancelled": "park",
  "filled->pending_filled": "park",
  "cancelled->pending_cancelled": "park",
  "pending_open->open": "confirm",
  "pending_accepted->accepted": "confirm",
  "pending_filled->filled": "confirm",
  "pending_cancelled->cancelled": "confirm",
  "slashed->filled": "compensation",
  "slashed->expired": "compensation",
};

const ALL_PAIRS = INTENT_STATES.flatMap((from) => INTENT_STATES.map((to) => [from, to] as const));

describe("TRANSITION_TABLE (issue #406)", () => {
  it("covers every state pair exactly as specified", () => {
    expect(ALL_PAIRS).toHaveLength(INTENT_STATES.length ** 2);
    for (const [from, to] of ALL_PAIRS) {
      expect([`${from}->${to}`, findRule(from, to)?.kind]).toEqual([
        `${from}->${to}`,
        EXPECTED[`${from}->${to}`],
      ]);
    }
  });

  it("has no duplicate edges and every rule audits and counts", () => {
    const keys = TRANSITION_TABLE.map((r) => `${r.from}->${r.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of TRANSITION_TABLE) {
      expect(r.sideEffects).toEqual(expect.arrayContaining(["metric", "audit"]));
      expect(r.defaultReason).not.toHaveLength(0);
      expect(r.guard).not.toHaveLength(0);
    }
  });

  it("only compensation edges need an override, and the DB seed excludes exactly those", () => {
    for (const r of TRANSITION_TABLE) expect(requiresOverride(r)).toBe(r.kind === "compensation");
    expect(DB_ALLOWED_TRANSITIONS.every((r) => r.kind !== "compensation")).toBe(true);
    expect(DB_ALLOWED_TRANSITIONS).toHaveLength(
      TRANSITION_TABLE.filter((r) => r.kind !== "compensation").length,
    );
  });

  it("keeps the lifecycle view (TRANSITIONS) free of terminal exits", () => {
    for (const [from, to] of ALL_PAIRS) {
      const kind = EXPECTED[`${from}->${to}`];
      const lifecycleLegal = kind !== undefined && kind !== "compensation" && !isTerminalState(from);
      expect([from, to, canTransition(from, to)]).toEqual([from, to, lifecycleLegal]);
    }
  });
});

describe("transition() (issue #406)", () => {
  const at = new Date("2026-10-20T00:00:00.000Z");

  it.each(ALL_PAIRS)("%s → %s plans exactly when the edge is legal", (from, to) => {
    const kind = EXPECTED[`${from}->${to}`];
    const run = () => transition({ intentId: "i-1", state: from }, to, { actor: "tester", at });
    if (kind === undefined || kind === "compensation") {
      expect(run).toThrow(IllegalTransitionError);
    } else {
      const plan = run();
      expect(plan).toMatchObject({ intentId: "i-1", from, to, rule: { kind } });
      expect(plan.audit).toEqual({
        timestamp: at.toISOString(),
        toState: to,
        actor: "tester",
        reason: plan.rule.defaultReason,
        metadata: { fromState: from },
      });
    }
  });

  it("allows a compensation edge only with an explicit override", () => {
    expect(() => transition({ intentId: "i-1", state: "slashed" }, "filled", { actor: "system" })).toThrow(
      /requires an override/,
    );
    const plan = transition({ intentId: "i-1", state: "slashed" }, "filled", {
      actor: "system",
      override: true,
      reason: "slash cancelled: fill_landed",
      metadata: { fillTxHash: "abc" },
    });
    expect(plan.rule.kind).toBe("compensation");
    expect(plan.audit).toMatchObject({
      reason: "slash cancelled: fill_landed",
      metadata: { fillTxHash: "abc", fromState: "slashed" },
    });
  });

  it("an override never legalises an edge that is not in the table", () => {
    expect(() =>
      transition({ intentId: "i-1", state: "filled" }, "open", { actor: "admin", override: true }),
    ).toThrow(/no such edge/);
  });
});
