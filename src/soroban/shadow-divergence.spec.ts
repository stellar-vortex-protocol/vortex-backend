import {
  asShadowDivergenceReason,
  asShadowTransition,
  classifyDivergence,
  classifySimulationFailure,
  classifySimulationResponse,
  expectedOutcomeFromOffchain,
  isContractRevert,
} from "./shadow-divergence";

describe("shadow-divergence — expectedOutcomeFromOffchain", () => {
  it("treats a committed transition as an expected success", () => {
    expect(expectedOutcomeFromOffchain(true)).toBe("ok");
  });

  it("treats a guard-blocked transition as an expected rejection", () => {
    expect(expectedOutcomeFromOffchain(false)).toBe("rejected");
  });
});

describe("shadow-divergence — isContractRevert", () => {
  it.each([
    "HostError: Error(Contract, #1, Error(Contract, #1, revert)",
    "Error(WasmVm, InvalidAction)",
    "transaction reverted",
    "Simulation reverted",
  ])("recognises a guard failure in %j", (detail) => {
    expect(isContractRevert(detail)).toBe(true);
  });

  it.each([
    "no account found",
    "connection reset by peer",
    "malformed XDR",
    "missing export",
  ])("does not mistake a hard failure (%j) for a guard failure", (detail) => {
    expect(isContractRevert(detail)).toBe(false);
  });

  it("handles a missing detail string", () => {
    expect(isContractRevert(undefined)).toBe(false);
  });
});

describe("shadow-divergence — classifySimulationResponse", () => {
  it("maps a response with no error member to ok", () => {
    expect(classifySimulationResponse({})).toEqual({ outcome: "ok", threw: false });
  });

  it("maps a contract guard failure to rejected, not error", () => {
    const result = classifySimulationResponse({
      error: "HostError: Error(Contract, #1, Error(Contract, #1, revert)",
    });
    expect(result.outcome).toBe("rejected");
    expect(result.threw).toBe(false);
  });

  it("maps a hard simulation error to error", () => {
    const result = classifySimulationResponse({ error: "no account found" });
    expect(result.outcome).toBe("error");
    expect(result.threw).toBe(false);
  });

  it("treats a missing response as a thrown failure, not a verdict", () => {
    const result = classifySimulationResponse(undefined);
    expect(result.outcome).toBe("error");
    expect(result.threw).toBe(true);
  });

  it("truncates long detail strings so a hostile RPC cannot flood the logs", () => {
    const result = classifySimulationResponse({ error: `revert${"x".repeat(500)}` });
    expect(result.outcome).toBe("rejected");
    expect(result.detail).toBeDefined();
    expect(result.detail!.length).toBeLessThanOrEqual(200);
  });

  it("still classifies a revert whose marker sits past the truncation point", () => {
    // The marker is deliberately at the very end: matching on the truncated
    // string would call this a hard error instead of a guard failure.
    const result = classifySimulationResponse({ error: `${"x".repeat(500)} ... reverted` });
    expect(result.outcome).toBe("rejected");
  });

  it("strips control characters from detail strings so they stay log-safe", () => {
    // A newline + NUL in the middle would otherwise let a hostile or buggy RPC
    // forge extra log lines.
    const withControlChars = `no account${String.fromCharCode(10)}found${String.fromCharCode(0)}`;
    const result = classifySimulationResponse({ error: withControlChars });
    expect(result.detail).toBe("no account found");
    const codes = [...result.detail!].map((ch) => ch.charCodeAt(0));
    expect(codes.every((code) => code >= 0x20 && code !== 0x7f)).toBe(true);
  });

  it("omits detail when the error member is only whitespace", () => {
    const result = classifySimulationResponse({ error: "   " });
    expect(result.outcome).toBe("error");
    expect(result.detail).toBeUndefined();
  });
});

describe("shadow-divergence — classifySimulationFailure", () => {
  it("marks a thrown Error as a thrown failure so it maps to simulation_exception", () => {
    const result = classifySimulationFailure(new Error("socket hang up"));
    expect(result).toEqual({ outcome: "error", threw: true, detail: "socket hang up" });
  });

  it("accepts a non-Error throw value", () => {
    expect(classifySimulationFailure("boom")).toEqual({
      outcome: "error",
      threw: true,
      detail: "boom",
    });
  });

  it("falls back to a non-empty detail for an empty string throw", () => {
    expect(classifySimulationFailure("").detail).toBe("unknown error");
  });
});

describe("shadow-divergence — classifyDivergence", () => {
  it("reports no divergence when both sides succeeded", () => {
    expect(classifyDivergence("ok", { outcome: "ok", threw: false })).toBeNull();
  });

  it("reports no divergence when both sides rejected", () => {
    expect(classifyDivergence("rejected", { outcome: "rejected", threw: false })).toBeNull();
  });

  it("flags a contract rejection where the off-chain path succeeded as a mismatch", () => {
    expect(classifyDivergence("ok", { outcome: "rejected", threw: false })).toBe("outcome_mismatch");
  });

  it("flags a contract success where the off-chain path refused as a mismatch", () => {
    expect(classifyDivergence("rejected", { outcome: "ok", threw: false })).toBe("outcome_mismatch");
  });

  it("flags a hard simulation error against a successful off-chain transition", () => {
    expect(classifyDivergence("ok", { outcome: "error", threw: false })).toBe("simulation_error");
  });

  it("does not flag a simulation error against a transition the off-chain path already failed", () => {
    expect(classifyDivergence("rejected", { outcome: "error", threw: false })).toBeNull();
  });

  it("flags a thrown simulation as simulation_exception regardless of expectation", () => {
    expect(classifyDivergence("ok", { outcome: "error", threw: true })).toBe("simulation_exception");
    expect(classifyDivergence("rejected", { outcome: "error", threw: true })).toBe(
      "simulation_exception",
    );
  });

  it("flags a missing simulation against a successful off-chain transition as unconfigured", () => {
    expect(classifyDivergence("ok", null)).toBe("contract_unconfigured");
  });

  it("does not flag a missing simulation against a transition that was already refused", () => {
    expect(classifyDivergence("rejected", null)).toBeNull();
  });

  it("never throws for any combination of outcomes", () => {
    const expectations = ["ok", "rejected", "error"] as const;
    const simulations = [
      null,
      { outcome: "ok", threw: false },
      { outcome: "rejected", threw: false },
      { outcome: "error", threw: false },
      { outcome: "error", threw: true },
    ] as const;

    for (const expected of expectations) {
      for (const simulated of simulations) {
        expect(() => classifyDivergence(expected, simulated)).not.toThrow();
      }
    }
  });
});

describe("shadow-divergence — label narrowing", () => {
  it("accepts the five enumerated transitions", () => {
    for (const transition of ["accept", "fill", "cancel", "expire", "slash"]) {
      expect(asShadowTransition(transition)).toBe(transition);
    }
  });

  it("rejects an unknown transition so metric cardinality stays bounded", () => {
    expect(asShadowTransition("create")).toBeNull();
    expect(asShadowTransition("")).toBeNull();
    expect(asShadowTransition("ACCEPT")).toBeNull();
  });

  it("accepts the enumerated divergence reasons", () => {
    for (const reason of [
      "outcome_mismatch",
      "simulation_error",
      "simulation_exception",
      "contract_unconfigured",
    ]) {
      expect(asShadowDivergenceReason(reason)).toBe(reason);
    }
  });

  it("rejects an unknown divergence reason", () => {
    expect(asShadowDivergenceReason("cosmic_rays")).toBeNull();
  });
});
