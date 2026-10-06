/**
 * Replay-engine tests (issue #452): dispatch, fills, fees/PnL, failures
 * and slashes, the simulated clock, and seed determinism.
 */
import { PriceBook } from "./prices";
import { ReplayEngine } from "./engine";
import { AlwaysFillStrategy } from "./strategies/always-fill.strategy";
import { MarginThresholdStrategy } from "./strategies/margin-threshold.strategy";
import type {
  ArchivedIntent,
  QuoteDecision,
  SimEvent,
  SimulatorStrategy,
  StrategyContext,
} from "./types";

/** Priced world: 1 USDC on both legs (EVM 6 decimals, Stellar 7). */
function makePrices(): PriceBook {
  return new PriceBook([
    { ts: 0, chain: "ethereum", symbol: "USDC", priceUsd: 1, decimals: 6 },
    { ts: 0, chain: "stellar", symbol: "USDC", priceUsd: 1, decimals: 7 },
  ]);
}

function makeIntent(over: Partial<ArchivedIntent> = {}): ArchivedIntent {
  return {
    intentId: "e-1",
    createdAt: 1_000,
    deadline: 1_600,
    srcChain: "ethereum",
    srcTokenSymbol: "USDC",
    srcAmount: "1000000000", // 1000 USDC
    dstTokenSymbol: "USDC",
    dstChain: "stellar",
    minDstAmount: "9960000000", // 996 USDC
    state: "open",
    ...over,
  };
}

function event(ts: number, over: Partial<ArchivedIntent> = {}): SimEvent {
  return { ts, intent: makeIntent({ createdAt: ts, ...over }) };
}

/** Strategy driven by a decision function, recording every hook call. */
function recordingStrategy(
  decide: (ctx: StrategyContext, intent: ArchivedIntent) => QuoteDecision | null,
): SimulatorStrategy & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "recording",
    calls,
    onIntent(ctx, intent) {
      calls.push(`intent:${intent.intentId}@${ctx.nowSec}`);
      return decide(ctx, intent);
    },
    onQuoteRequest(ctx, intent) {
      calls.push(`quote:${intent.intentId}@${ctx.nowSec}`);
      return decide(ctx, intent);
    },
    onTick(_ctx, nowSec) {
      calls.push(`tick@${nowSec}`);
    },
  };
}

describe("ReplayEngine (issue #452)", () => {
  it("fills every intent through the always-fill strategy and prices PnL via the fee engine", () => {
    const events = [event(1_000), event(1_010, { intentId: "e-2" }), event(1_020, { intentId: "e-3" })];
    const report = new ReplayEngine({
      strategy: new AlwaysFillStrategy(),
      params: { seed: 1, gasUsdPerFill: 0.1 },
      prices: makePrices(),
    }).run(events);

    // Per fill: 1000 − 996 − fee(0.498) − gas(0.1) = 3.402.
    expect(report.totals.events).toBe(3);
    expect(report.totals.quotesSubmitted).toBe(3);
    expect(report.totals.filled).toBe(3);
    expect(report.totals.fillRate).toBe(1);
    expect(report.totals.captureRate).toBe(1);
    expect(report.totals.volumeUsd).toBeCloseTo(3_000, 9);
    expect(report.totals.feesPaidUsd).toBeCloseTo(3 * 0.498, 9);
    expect(report.totals.gasPaidUsd).toBeCloseTo(0.3, 9);
    expect(report.totals.pnlUsd).toBeCloseTo(3 * 3.402, 9);
    expect(report.totals.slashEvents).toBe(0);
    expect(report.totals.unknownPriceFills).toBe(0);
    expect(report.strategy).toBe("always-fill");
    expect(report.params.seed).toBe(1);
  });

  it("applies the configured fee bps to every fill", () => {
    const events = [event(1_000)];
    const free = new ReplayEngine({
      strategy: new AlwaysFillStrategy(),
      params: { feeBps: 0 },
      prices: makePrices(),
    }).run(events);
    const expensive = new ReplayEngine({
      strategy: new AlwaysFillStrategy(),
      params: { feeBps: 100 },
      prices: makePrices(),
    }).run(events);
    expect(free.totals.feesPaidUsd).toBe(0);
    expect(free.totals.pnlUsd).toBeCloseTo(4, 9); // 1000 − 996
    expect(expensive.totals.feesPaidUsd).toBeCloseTo(9.96, 9); // 1% of 996
    expect(expensive.totals.pnlUsd).toBeCloseTo(-5.96, 9);
    expect(expensive.totals.pnlUsd).toBeLessThan(free.totals.pnlUsd);
  });

  it("declines below the margin threshold and fills above it", () => {
    const events = [event(1_000)];
    const pass = new ReplayEngine({
      strategy: new MarginThresholdStrategy(),
      params: { minMarginBps: 35 },
      prices: makePrices(),
    }).run(events);
    const fail = new ReplayEngine({
      strategy: new MarginThresholdStrategy(),
      params: { minMarginBps: 36 },
      prices: makePrices(),
    }).run(events);
    expect(pass.totals.filled).toBe(1);
    expect(fail.totals.filled).toBe(0);
    expect(fail.totals.quotesDeclined).toBe(1);
  });

  it("charges a below-minimum quote as a failed fill and a slash", () => {
    const strategy = recordingStrategy(() => ({ dstAmount: "1" }));
    const report = new ReplayEngine({ strategy, params: { slashPenaltyUsd: 25 } }).run([event(1_000)]);
    expect(report.totals.quotesSubmitted).toBe(1);
    expect(report.totals.filled).toBe(0);
    expect(report.totals.failedFills).toBe(1);
    expect(report.totals.failedBelowMin).toBe(1);
    expect(report.totals.slashEvents).toBe(1);
    expect(report.totals.slashPenaltyUsd).toBe(25);
  });

  it("fails and slashes fills scheduled past the intent deadline", () => {
    const strategy = recordingStrategy(() => ({ dstAmount: "9960000000", fillDelayMs: 601_000 }));
    const report = new ReplayEngine({ strategy }).run([event(1_000)]);
    expect(report.totals.filled).toBe(0);
    expect(report.totals.failedLate).toBe(1);
    expect(report.totals.slashEvents).toBe(1);
  });

  it("tightens lateness with the fill-window protocol parameter", () => {
    const strategy = recordingStrategy(() => ({ dstAmount: "9960000000", fillDelayMs: 200_000 }));
    const events = [event(1_000)]; // deadline 1600 → delay 200 s fits the deadline
    const noWindow = new ReplayEngine({ strategy, params: { fillWindowSec: 0 } }).run(events);
    expect(noWindow.totals.filled).toBe(1);
    const windowed = new ReplayEngine({ strategy, params: { fillWindowSec: 100 } }).run(events);
    expect(windowed.totals.filled).toBe(0);
    expect(windowed.totals.failedLate).toBe(1);
    expect(windowed.totals.slashEvents).toBe(1);
  });

  it("dispatches intents and quote requests to their own hooks", () => {
    const strategy = recordingStrategy(() => ({ dstAmount: "9960000000" }));
    const events: SimEvent[] = [
      { ts: 1_000, intent: makeIntent({ createdAt: 1_000 }) },
      { ts: 1_010, intent: makeIntent({ createdAt: 1_010, intentId: "rfq-1", event: "quote_request" }) },
    ];
    const report = new ReplayEngine({ strategy }).run(events);
    expect(report.totals.intentEvents).toBe(1);
    expect(report.totals.quoteRequests).toBe(1);
    expect(strategy.calls.filter((c) => c.startsWith("intent:"))).toEqual(["intent:e-1@1000"]);
    expect(strategy.calls.filter((c) => c.startsWith("quote:"))).toEqual(["quote:rfq-1@1010"]);
  });

  it("ticks once per clock advance, before the event dispatch", () => {
    const strategy = recordingStrategy(() => null);
    const events: SimEvent[] = [
      { ts: 1_000, intent: makeIntent({ createdAt: 1_000, intentId: "a" }) },
      { ts: 1_000, intent: makeIntent({ createdAt: 1_000, intentId: "b" }) },
      { ts: 1_010, intent: makeIntent({ createdAt: 1_010, intentId: "c" }) },
      { ts: 1_050, intent: makeIntent({ createdAt: 1_050, intentId: "d" }) },
    ];
    new ReplayEngine({ strategy }).run(events);
    expect(strategy.calls).toEqual([
      "tick@1000",
      "intent:a@1000",
      "intent:b@1000",
      "tick@1010",
      "intent:c@1010",
      "tick@1050",
      "intent:d@1050",
    ]);
  });

  it("counts fills with unknown prices but excludes them from USD totals", () => {
    const report = new ReplayEngine({ strategy: new AlwaysFillStrategy() }).run([event(1_000)]);
    expect(report.totals.filled).toBe(1);
    expect(report.totals.unknownPriceFills).toBe(1);
    expect(report.totals.pnlUsd).toBe(0);
    expect(report.totals.volumeUsd).toBe(0);
    expect(report.totals.feesPaidUsd).toBe(0);
  });

  it("prices the source leg from usdValueAtCreate when the book lacks it", () => {
    const stellarOnly = new PriceBook([{ ts: 0, chain: "stellar", symbol: "USDC", priceUsd: 1, decimals: 7 }]);
    const report = new ReplayEngine({
      strategy: new AlwaysFillStrategy(),
      prices: stellarOnly,
    }).run([event(1_000, { usdValueAtCreate: 1_000 })]);
    expect(report.totals.unknownPriceFills).toBe(0);
    expect(report.totals.pnlUsd).toBeCloseTo(1_000 - 996 - 0.498, 9);
  });

  it("sorts events by time without mutating the input array", () => {
    const strategy = recordingStrategy(() => null);
    const events = [event(2_000, { intentId: "second" }), event(1_000, { intentId: "first" })];
    const before = JSON.stringify(events);
    new ReplayEngine({ strategy }).run(events);
    expect(JSON.stringify(events)).toBe(before);
    expect(strategy.calls).toEqual(["tick@1000", "intent:first@1000", "tick@2000", "intent:second@2000"]);
  });

  it("produces an identical report for the same seed, and a different one otherwise", () => {
    const randomStrategy: SimulatorStrategy = {
      name: "random",
      onIntent: (ctx, intent) =>
        ctx.random() < 0.5
          ? { dstAmount: intent.minDstAmount, fillDelayMs: Math.floor(ctx.random() * 600) * 1_000 }
          : null,
      onQuoteRequest: () => null,
      onTick: () => undefined,
    };
    const events = Array.from({ length: 16 }, (_, i) => event(1_000 + i, { intentId: `r-${i}` }));

    const run = (seed: number) =>
      JSON.stringify(new ReplayEngine({ strategy: randomStrategy, params: { seed } }).run(events));

    expect(run(42)).toBe(run(42));
    expect(run(42)).not.toBe(run(43));
  });

  it("computes average fill latency across settled fills", () => {
    const strategy = recordingStrategy(() => ({ dstAmount: "9960000000", fillDelayMs: 30_000 }));
    const report = new ReplayEngine({ strategy }).run([event(1_000), event(1_010, { intentId: "e-2" })]);
    expect(report.totals.filled).toBe(2);
    expect(report.totals.avgFillLatencyMs).toBe(30_000);
  });
});
