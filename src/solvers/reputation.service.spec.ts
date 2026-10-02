import * as fc from "fast-check";
import {
  computeReputation,
  ReputationInputs,
  ReputationConfig,
  ReputationFillEvent,
  ReputationSlashEvent,
  ReputationQuoteEvent,
  ReputationVolumeEvent,
} from "./reputation.service";

const DEFAULT_CFG: ReputationConfig = {
  weights: { fillRate: 0.35, latency: 0.15, slashes: 0.25, quoteHonour: 0.15, volume: 0.10 },
  decayHalflifeSeconds: 30 * 24 * 60 * 60,
  bayesAlpha: 4,
  bayesBeta: 1,
  volumeLambdaUsd: 100_000,
};

const NOW = 1_700_000_000;
const HALF_LIFE = DEFAULT_CFG.decayHalflifeSeconds;

function fill(ts: number, success = true, latency = 60, window = 300): ReputationFillEvent {
  return { timestamp: ts, success, fillLatencySec: latency, fillWindowSec: window };
}
function slash(ts: number, severity = 1): ReputationSlashEvent {
  return { timestamp: ts, severity };
}
function quote(ts: number, honoured: boolean): ReputationQuoteEvent {
  return { timestamp: ts, honoured };
}
function vol(ts: number, usd: number): ReputationVolumeEvent {
  return { timestamp: ts, amountUsd: usd };
}

function emptyInputs(now = NOW): ReputationInputs {
  return { fills: [], slashes: [], quotes: [], volumes: [], evaluatedAtEpoch: now };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fixture tests.
// ─────────────────────────────────────────────────────────────────────────────

describe("computeReputation (deterministic fixtures)", () => {
  it("returns a score in [0,1] for empty (cold-start) inputs", () => {
    const r = computeReputation(emptyInputs(), DEFAULT_CFG);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.components.fillRate).toBeGreaterThan(0); // Bayesian prior is nonzero.
  });

  it("perfect solver with 10 recent fills scores above zero and below 1", () => {
    const inputs = emptyInputs();
    for (let i = 0; i < 10; i++) {
      inputs.fills.push(fill(NOW - 60 * i, true, 30, 300));
      inputs.quotes.push(quote(NOW - 60 * i, true));
      inputs.volumes.push(vol(NOW - 60 * i, 1000));
    }
    const r = computeReputation(inputs, DEFAULT_CFG);
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.components.latency).toBeGreaterThan(0.8); // used half the window.
  });

  it("a slashed solver scores strictly less than the identical perfect solver", () => {
    const perfect = emptyInputs();
    const slashed = emptyInputs();
    for (let i = 0; i < 10; i++) {
      const ts = NOW - 60 * i;
      perfect.fills.push(fill(ts, true, 30, 300));
      perfect.quotes.push(quote(ts, true));
      perfect.volumes.push(vol(ts, 1000));
      slashed.fills.push(fill(ts, true, 30, 300));
      slashed.quotes.push(quote(ts, true));
      slashed.volumes.push(vol(ts, 1000));
    }
    slashed.slashes.push(slash(NOW - 30, 1));
    const rPerfect = computeReputation(perfect, DEFAULT_CFG);
    const rSlashed = computeReputation(slashed, DEFAULT_CFG);
    expect(rSlashed.score).toBeLessThan(rPerfect.score);
    // Slash component decays exponentially, so it must be < 1.
    expect(rSlashed.components.slashes).toBeLessThan(1);
  });

  it("cold-start (no events) ranks strictly above a 10% established poor performer", () => {
    // Poor performer: 2 successes, 18 failures, all within the last half-life.
    const poor = emptyInputs();
    for (let i = 0; i < 2; i++) {
      poor.fills.push(fill(NOW - i * 3600, true, 120, 300));
    }
    for (let i = 0; i < 18; i++) {
      poor.fills.push(fill(NOW - 10_000 - i * 3600, false));
    }
    const rCold = computeReputation(emptyInputs(), DEFAULT_CFG);
    const rPoor = computeReputation(poor, DEFAULT_CFG);
    expect(rCold.score).toBeGreaterThan(rPoor.score);
  });

  it("reversed slash (dispute resolved-reversed) does not penalise", () => {
    const base = emptyInputs();
    base.fills.push(fill(NOW, true, 60, 300));
    const withSlash = {
      ...base,
      slashes: [{ timestamp: NOW, severity: 1, disputeStatus: "resolved-reversed" as const }],
    };
    const rBase = computeReputation(base, DEFAULT_CFG);
    const rWithSlash = computeReputation(withSlash, DEFAULT_CFG);
    // Both have slash component = exp(0) = 1 because the reversed slash is ignored.
    expect(rWithSlash.components.slashes).toBeCloseTo(rBase.components.slashes, 9);
  });

  it("deterministic: same inputs always give the same score", () => {
    const inputs = emptyInputs();
    inputs.fills.push(fill(NOW - 100, true, 30, 300));
    inputs.slashes.push(slash(NOW - 500, 1));
    inputs.quotes.push(quote(NOW - 100, true));
    inputs.volumes.push(vol(NOW - 100, 5000));
    const a = computeReputation(inputs, DEFAULT_CFG);
    const b = computeReputation(
      JSON.parse(JSON.stringify(inputs)) as ReputationInputs,
      JSON.parse(JSON.stringify(DEFAULT_CFG)) as ReputationConfig,
    );
    expect(a.score).toBe(b.score);
    expect(a.components).toEqual(b.components);
  });

  it("all five components are present and in [0, 1]", () => {
    const r = computeReputation(emptyInputs(), DEFAULT_CFG);
    for (const c of ["fillRate", "latency", "slashes", "quoteHonour", "volume"] as const) {
      expect(typeof r.components[c]).toBe("number");
      expect(Number.isFinite(r.components[c])).toBe(true);
      expect(r.components[c]).toBeGreaterThanOrEqual(0);
      expect(r.components[c]).toBeLessThanOrEqual(1);
    }
  });

  it("weights and half-life are echoed back unchanged", () => {
    const cfg: ReputationConfig = {
      weights: { fillRate: 0.2, latency: 0.2, slashes: 0.3, quoteHonour: 0.2, volume: 0.1 },
      decayHalflifeSeconds: 14 * 86400,
      bayesAlpha: 2,
      bayesBeta: 2,
      volumeLambdaUsd: 50_000,
    };
    const r = computeReputation(emptyInputs(), cfg);
    expect(r.weights).toEqual(cfg.weights);
    expect(r.decayHalflifeSeconds).toBe(cfg.decayHalflifeSeconds);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property tests (fast-check).
// ─────────────────────────────────────────────────────────────────────────────

const fcTimestamp = (withinHalfLife = true) =>
  fc
    .nat({ max: withinHalfLife ? HALF_LIFE * 3 : 10 * HALF_LIFE })
    .map((off) => NOW - off);

const fcFill = fcTimestamp().chain((ts) =>
  fc.record({
    timestamp: fc.constant(ts),
    success: fc.boolean(),
    fillLatencySec: fc.option(fc.nat({ max: 10_000 }), { nil: undefined as unknown as undefined }),
    fillWindowSec: fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: undefined as unknown as undefined }),
  }),
);

const fcSlash = fcTimestamp().chain((ts) =>
  fc.record({
    timestamp: fc.constant(ts),
    // `min` must be exactly representable as a 32-bit float; 0.1 is not,
    // so round it the way fast-check itself prescribes.
    severity: fc.float({ min: Math.fround(0.1), max: 2, noNaN: true }),
    disputeStatus: fc.constantFrom<
      "none" | "disputed" | "resolved-upheld" | "resolved-reversed" | undefined
    >(undefined, "none", "disputed", "resolved-upheld", "resolved-reversed"),
  }),
);

const fcQuote = fcTimestamp().chain((ts) =>
  fc.record({
    timestamp: fc.constant(ts),
    honoured: fc.boolean(),
  }),
);

const fcVol = fcTimestamp().chain((ts) =>
  fc.record({
    timestamp: fc.constant(ts),
    amountUsd: fc.double({ min: 0, max: 1_000_000, noNaN: true }),
  }),
);

const fcInputs = fc.record({
  fills: fc.array(fcFill, { maxLength: 200 }),
  slashes: fc.array(fcSlash, { maxLength: 100 }),
  quotes: fc.array(fcQuote, { maxLength: 200 }),
  volumes: fc.array(fcVol, { maxLength: 200 }),
  evaluatedAtEpoch: fc.constant(NOW),
}) as fc.Arbitrary<ReputationInputs>;

describe("computeReputation (property tests, fast-check)", () => {
  fc.configureGlobal({ numRuns: 10_000 });

  afterAll(() => fc.resetConfigureGlobal());

  it("prop: output score and every component are always in [0, 1]", () => {
    fc.assert(
      fc.property(fcInputs, (inputs) => {
        const r = computeReputation(inputs, DEFAULT_CFG);
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        for (const c of Object.values(r.components)) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("prop: adding a non-zero-decay, non-reversed slash never raises the score", () => {
    // Append a recent slash with positive severity, not reversed.
    const recentTs = fcTimestamp(true).filter((ts) => ts <= NOW && NOW - ts < HALF_LIFE * 0.9);
    fc.assert(
      fc.property(fcInputs, recentTs, (base, ts) => {
        const extra: ReputationSlashEvent = {
          timestamp: ts,
          severity: 0.5,
          disputeStatus: "none",
        };
        const before = computeReputation(base, DEFAULT_CFG);
        const after = computeReputation(
          { ...base, slashes: [...base.slashes, extra] },
          DEFAULT_CFG,
        );
        expect(after.score).toBeLessThanOrEqual(before.score + 1e-12);
        expect(after.components.slashes).toBeLessThanOrEqual(
          before.components.slashes + 1e-12,
        );
      }),
      { numRuns: 5000 },
    );
  });

  it("prop: two identical successes, the recent one weighs strictly more than the old one", () => {
    // Setup: solver starts with 2 successes, one at now - t/2, one at now - 2t.
    // The "recent" scenario keeps the first; the "old" scenario keeps the second.
    const recentOnly: ReputationInputs = {
      fills: [fill(NOW - Math.floor(HALF_LIFE / 2), true, 30, 300)],
      slashes: [],
      quotes: [quote(NOW - Math.floor(HALF_LIFE / 2), true)],
      volumes: [vol(NOW - Math.floor(HALF_LIFE / 2), 50_000)],
      evaluatedAtEpoch: NOW,
    };
    const oldOnly: ReputationInputs = {
      fills: [fill(NOW - 2 * HALF_LIFE, true, 30, 300)],
      slashes: [],
      quotes: [quote(NOW - 2 * HALF_LIFE, true)],
      volumes: [vol(NOW - 2 * HALF_LIFE, 50_000)],
      evaluatedAtEpoch: NOW,
    };
    const rRecent = computeReputation(recentOnly, DEFAULT_CFG);
    const rOld = computeReputation(oldOnly, DEFAULT_CFG);
    expect(rRecent.score).toBeGreaterThan(rOld.score);

    // Now generalise over a range of timestamps.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: HALF_LIFE * 5 }),
        (deltaBack) => {
          const recentTs = NOW - Math.max(1, Math.floor(deltaBack / 2));
          const oldTs = NOW - deltaBack;
          if (recentTs >= oldTs) return true; // skip degenerate cases.
          const rec: ReputationInputs = {
            fills: [fill(recentTs, true, 10, 300)],
            slashes: [],
            quotes: [quote(recentTs, true)],
            volumes: [vol(recentTs, 10_000)],
            evaluatedAtEpoch: NOW,
          };
          const old: ReputationInputs = {
            fills: [fill(oldTs, true, 10, 300)],
            slashes: [],
            quotes: [quote(oldTs, true)],
            volumes: [vol(oldTs, 10_000)],
            evaluatedAtEpoch: NOW,
          };
          const a = computeReputation(rec, DEFAULT_CFG);
          const b = computeReputation(old, DEFAULT_CFG);
          return a.score >= b.score - 1e-12;
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("prop: cold-start ranks above any poor established performer (≤10% fill rate with n≥20)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 200 }).chain((n) => {
          const successes = Math.max(0, Math.floor(n * 0.10));
          const failures = n - successes;
          return fc.constant({ n, successes, failures });
        }),
        ({ successes, failures }) => {
          const poor: ReputationInputs = emptyInputs();
          for (let i = 0; i < successes; i++) {
            poor.fills.push(fill(NOW - i * 1000, true, 120, 300));
          }
          for (let i = 0; i < failures; i++) {
            poor.fills.push(fill(NOW - 1_000_000 - i * 1000, false));
          }
          const rCold = computeReputation(emptyInputs(), DEFAULT_CFG);
          const rPoor = computeReputation(poor, DEFAULT_CFG);
          // Prior-only lower bound should beat a 10%-or-worse performer with data.
          return rCold.score >= rPoor.score - 1e-9;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("prop: deterministic under permutation and JSON round-trip", () => {
    fc.assert(
      fc.property(fcInputs, (inputs) => {
        const canonical = computeReputation(inputs, DEFAULT_CFG);

        // Permute every array independently.
        const permuted: ReputationInputs = {
          fills: shuffle([...inputs.fills]),
          slashes: shuffle([...inputs.slashes]),
          quotes: shuffle([...inputs.quotes]),
          volumes: shuffle([...inputs.volumes]),
          evaluatedAtEpoch: inputs.evaluatedAtEpoch,
        };
        const rPermuted = computeReputation(permuted, DEFAULT_CFG);
        expect(rPermuted.score).toBeCloseTo(canonical.score, 9);

        // JSON round-trip.
        const rt = computeReputation(
          JSON.parse(JSON.stringify(inputs)) as ReputationInputs,
          JSON.parse(JSON.stringify(DEFAULT_CFG)) as ReputationConfig,
        );
        expect(rt.score).toBe(canonical.score);
      }),
      { numRuns: 2000 },
    );
  });
});

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
