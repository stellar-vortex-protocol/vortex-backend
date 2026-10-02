/**
 * Unit tests for the strategy hooks, the shared accept gate, and the
 * fill-window deadline (issue #452).
 */
import { DEFAULT_FEE_RULE, quoteFee } from "../../src/fees/fee-engine";
import { createPrng } from "./prng";
import { PriceBook } from "./prices";
import { AlwaysFillStrategy } from "./strategies/always-fill.strategy";
import { attemptGateReason, effectiveDeadline } from "./strategies/gate";
import { MarginThresholdStrategy } from "./strategies/margin-threshold.strategy";
import type { ArchivedIntent, StrategyContext } from "./types";
import { DEFAULT_SIM_PARAMS } from "./types";

/** Priced world: 1 USDC on both legs (EVM 6 decimals, Stellar 7). */
function makePrices(): PriceBook {
  return new PriceBook([
    { ts: 0, chain: "ethereum", symbol: "USDC", priceUsd: 1, decimals: 6 },
    { ts: 0, chain: "stellar", symbol: "USDC", priceUsd: 1, decimals: 7 },
  ]);
}

function makeIntent(over: Partial<ArchivedIntent> = {}): ArchivedIntent {
  return {
    intentId: "u-1",
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

function makeCtx(over: Partial<StrategyContext> = {}): StrategyContext {
  const feeRules = [{ ...DEFAULT_FEE_RULE, id: "sim", bps: 5 }];
  const ctx: StrategyContext = {
    nowSec: 1_000,
    params: { ...DEFAULT_SIM_PARAMS },
    prices: makePrices(),
    feeRules,
    random: createPrng(1),
    route: () => ({ steps: [], totalTime: 60, totalFeesUSD: 0, priceImpact: 0 }),
    fee: (amount, intent) =>
      quoteFee(feeRules, [], {
        amount,
        srcChain: intent.srcChain,
        dstChain: intent.dstChain ?? "stellar",
      }),
    // Reads through the final object so a `prices` override below applies here too.
    valueUsd: (chain, symbol, amountBase, ts) => ctx.prices.usdValue(chain, symbol, amountBase, ts),
    ...over,
  };
  return ctx;
}

describe("attemptGateReason (issue #452)", () => {
  const base = { chains: ["ethereum"], minMarginBps: 0, nowSec: 1_000 };

  it("accepts an open, on-chain, in-deadline intent", () => {
    expect(attemptGateReason(makeIntent(), base)).toBeNull();
  });

  it("applies precedence: state, deadline, chain, margin", () => {
    expect(attemptGateReason(makeIntent({ state: "filled" }), base)).toBe("state");
    expect(attemptGateReason(makeIntent({ deadline: 1_000 }), base)).toBe("deadline");
    expect(attemptGateReason(makeIntent({ srcChain: "base" }), base)).toBe("chain");
    expect(
      attemptGateReason(makeIntent({ minDstAmount: "1" }), { ...base, minMarginBps: 10 }),
    ).toBe("margin");
  });

  it("ignores state only when the caller opts in (replay rows)", () => {
    const intent = makeIntent({ state: "filled" });
    expect(attemptGateReason(intent, { ...base, ignoreState: true })).toBeNull();
    expect(attemptGateReason(intent, base)).toBe("state");
    // A missing state is treated as open either way (creation-moment rows).
    expect(attemptGateReason(makeIntent({ state: undefined }), base)).toBeNull();
  });

  it("uses the bot's absolute margin heuristic", () => {
    // 1_000_000 * (bps / 10_000) base units of minDstAmount.
    expect(attemptGateReason(makeIntent({ minDstAmount: "999" }), { ...base, minMarginBps: 10 })).toBe("margin");
    expect(attemptGateReason(makeIntent({ minDstAmount: "1000" }), { ...base, minMarginBps: 10 })).toBeNull();
  });
});

describe("effectiveDeadline (issue #452)", () => {
  const intent = makeIntent({ createdAt: 1_000, deadline: 1_600 });

  it("returns the intent deadline when no window is configured", () => {
    expect(effectiveDeadline(intent, 0)).toBe(1_600);
  });

  it("tightens to createdAt + window when a window is configured", () => {
    expect(effectiveDeadline(intent, 100)).toBe(1_100);
    expect(effectiveDeadline(intent, 600)).toBe(1_600);
    expect(effectiveDeadline(intent, 900)).toBe(1_600);
  });
});

describe("AlwaysFillStrategy (issue #452)", () => {
  const strategy = new AlwaysFillStrategy();

  it("quotes minDstAmount immediately for gate-passing intents", () => {
    const decision = strategy.onIntent(makeCtx(), makeIntent());
    expect(decision).toEqual({ dstAmount: "9960000000", fillDelayMs: 0 });
  });

  it("gives RFQ rounds the same answer as broadcast intents", () => {
    expect(strategy.onQuoteRequest(makeCtx(), makeIntent())).toEqual(
      strategy.onIntent(makeCtx(), makeIntent()),
    );
  });

  it("declines intents outside the chain allowlist", () => {
    expect(strategy.onIntent(makeCtx(), makeIntent({ srcChain: "dogechain" }))).toBeNull();
    expect(new AlwaysFillStrategy({ chains: ["base"] }).onIntent(makeCtx(), makeIntent())).toBeNull();
    expect(new AlwaysFillStrategy({ chains: ["ethereum"] }).onIntent(makeCtx(), makeIntent())).not.toBeNull();
  });

  it("has a no-op tick", () => {
    expect(() => strategy.onTick(makeCtx(), 1_100)).not.toThrow();
  });
});

describe("MarginThresholdStrategy (issue #452)", () => {
  const strategy = new MarginThresholdStrategy();

  it("quotes when the fee-adjusted margin clears the threshold", () => {
    // margin = (1000 − 996 − 0.498) / 1000 → 35.02 bps.
    expect(strategy.onIntent(makeCtx({ nowSec: 1_000 }), makeIntent())).not.toBeNull();
    const higher = new MarginThresholdStrategy({ minMarginBps: 36 });
    expect(higher.onIntent(makeCtx({ nowSec: 1_000 }), makeIntent())).toBeNull();
  });

  it("declines when the destination leg cannot be priced", () => {
    const noDstPrices = makeCtx({
      prices: new PriceBook([{ ts: 0, chain: "ethereum", symbol: "USDC", priceUsd: 1, decimals: 6 }]),
    });
    expect(strategy.onIntent(noDstPrices, makeIntent())).toBeNull();
  });

  it("declines when the source leg cannot be valued (never guesses)", () => {
    const noSrcPrices = makeCtx({
      prices: new PriceBook([{ ts: 0, chain: "stellar", symbol: "USDC", priceUsd: 1, decimals: 7 }]),
    });
    expect(strategy.onIntent(noSrcPrices, makeIntent())).toBeNull();
  });

  it("prefers usdValueAtCreate over the price book for the source leg", () => {
    // Source price missing from the book; captured value makes it workable.
    const ctx = makeCtx({
      prices: new PriceBook([{ ts: 0, chain: "stellar", symbol: "USDC", priceUsd: 1, decimals: 7 }]),
    });
    expect(strategy.onIntent(ctx, makeIntent({ usdValueAtCreate: 1_000 }))).not.toBeNull();
  });

  it("declines when routing says settlement cannot fit the window", () => {
    const slowRoute = makeCtx({ route: () => ({ steps: [], totalTime: 10_000, totalFeesUSD: 0, priceImpact: 0 }) });
    expect(strategy.onIntent(slowRoute, makeIntent())).toBeNull();
  });

  describe("Dutch-auction waiting", () => {
    const sniper = new MarginThresholdStrategy({ minMarginBps: 50, useAuction: true });
    const auctionIntent = makeIntent({
      minDstAmount: "9900000000", // $990 floor
      deadline: 1_600,
      usdValueAtCreate: 1_000, // source leg: $1000
      auction: {
        startDstAmount: "10100000000", // $1010 start → negative margin at t=1000
        decayStart: 1_000,
        decayEnd: 1_100,
      },
    });

    it("waits for decay to clear the threshold, then fills at the decayed price", () => {
      const decision = sniper.onIntent(makeCtx({ nowSec: 1_000 }), auctionIntent);
      // price(t) = 1010 − 20·(t−1000)/100; margin crosses 50 bps at t=1078.
      expect(decision).toEqual({ dstAmount: "9944000000", fillDelayMs: 78_000 });
    });

    it("declines when even full decay misses the threshold", () => {
      const greedy = new MarginThresholdStrategy({ minMarginBps: 5_000, useAuction: true });
      expect(greedy.onIntent(makeCtx({ nowSec: 1_000 }), auctionIntent)).toBeNull();
    });

    it("fills immediately when the start price already clears the threshold", () => {
      const early = new MarginThresholdStrategy({ minMarginBps: -10_000, useAuction: true });
      const decision = early.onIntent(makeCtx({ nowSec: 1_000 }), auctionIntent);
      expect(decision?.fillDelayMs).toBe(0);
      expect(decision?.dstAmount).toBe("10100000000");
    });

    it("falls back to the plain quote when the intent has no auction", () => {
      const plain = new MarginThresholdStrategy({ minMarginBps: 0, useAuction: true });
      const decision = plain.onIntent(makeCtx({ nowSec: 1_000 }), makeIntent({ auction: undefined }));
      expect(decision?.dstAmount).toBe("9960000000");
      expect(decision?.fillDelayMs).toBe(0);
    });
  });
});
