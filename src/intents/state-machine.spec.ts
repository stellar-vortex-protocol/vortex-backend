import { canTransition, assertTransition, isTerminalState, TRANSITIONS } from "./state-machine";

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
