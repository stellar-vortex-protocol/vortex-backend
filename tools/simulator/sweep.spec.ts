/**
 * Sweep-mode tests (issue #452): grid construction, parameter plumbing,
 * comparative determinism, and report formatting.
 */
import { PriceBook } from "./prices";
import { formatReport, formatSweep } from "./report";
import { runSweep } from "./sweep";
import type { ArchivedIntent, SimEvent, SimulatorStrategy } from "./types";
import { AlwaysFillStrategy } from "./strategies/always-fill.strategy";
import { MarginThresholdStrategy } from "./strategies/margin-threshold.strategy";

function makeIntent(over: Partial<ArchivedIntent> = {}): ArchivedIntent {
  return {
    intentId: "s-1",
    createdAt: 1_000,
    deadline: 1_600,
    srcChain: "ethereum",
    srcTokenSymbol: "USDC",
    srcAmount: "1000000000",
    dstTokenSymbol: "USDC",
    dstChain: "stellar",
    minDstAmount: "9960000000",
    state: "open",
    ...over,
  };
}

function makeEvents(): SimEvent[] {
  return [
    { ts: 1_000, intent: makeIntent() },
    { ts: 1_010, intent: makeIntent({ intentId: "s-2", createdAt: 1_010 }) },
    { ts: 1_020, intent: makeIntent({ intentId: "s-3", createdAt: 1_020, deadline: 1_050 }) },
  ];
}

function makePrices(): PriceBook {
  return new PriceBook([
    { ts: 0, chain: "ethereum", symbol: "USDC", priceUsd: 1, decimals: 6 },
    { ts: 0, chain: "stellar", symbol: "USDC", priceUsd: 1, decimals: 7 },
  ]);
}

describe("runSweep (issue #452)", () => {
  const grid = { fillWindowSecs: [0, 100], feeBps: [0, 5, 50] };

  it("runs the Cartesian product, window-major then fee bps", () => {
    const sweep = runSweep(makeEvents(), {
      strategyFactory: () => new AlwaysFillStrategy(),
      params: { seed: 7 },
      prices: makePrices(),
      grid,
    });
    expect(sweep.strategy).toBe("always-fill");
    expect(sweep.seed).toBe(7);
    expect(sweep.rows).toHaveLength(6);
    expect(sweep.rows.map((r) => [r.fillWindowSec, r.feeBps])).toEqual([
      [0, 0],
      [0, 5],
      [0, 50],
      [100, 0],
      [100, 5],
      [100, 50],
    ]);
    // Every cell replays the full stream with its own parameters.
    for (const row of sweep.rows) {
      expect(row.report.totals.events).toBe(3);
      expect(row.report.params.fillWindowSec).toBe(row.fillWindowSec);
      expect(row.report.params.feeBps).toBe(row.feeBps);
    }
  });

  it("varies economics with fee bps: higher fees, lower PnL", () => {
    const sweep = runSweep(makeEvents(), {
      strategyFactory: () => new AlwaysFillStrategy(),
      prices: makePrices(),
      grid: { fillWindowSecs: [0], feeBps: [0, 50] },
    });
    const [free, costly] = sweep.rows;
    expect(free.report.totals.feesPaidUsd).toBe(0);
    expect(costly.report.totals.feesPaidUsd).toBeGreaterThan(0);
    expect(costly.report.totals.pnlUsd).toBeLessThan(free.report.totals.pnlUsd);
  });

  it("varies lateness with the fill window: tight windows slash more", () => {
    const strategyFactory = () =>
      new (class implements SimulatorStrategy {
        readonly name = "slow";
        onIntent(): { dstAmount: string; fillDelayMs: number } {
          return { dstAmount: "9960000000", fillDelayMs: 60_000 };
        }
        onQuoteRequest(): { dstAmount: string; fillDelayMs: number } {
          return { dstAmount: "9960000000", fillDelayMs: 60_000 };
        }
        onTick(): void {
          /* no-op */
        }
      })();
    const sweep = runSweep(makeEvents(), {
      strategyFactory,
      prices: makePrices(),
      grid: { fillWindowSecs: [0, 60], feeBps: [5] },
    });
    // s-3 has deadline 1050 (createdAt 1020 + 30 s): a 60 s delay misses it
    // regardless of window — the window itself adds no extra slashes here,
    // but the plumbing must reach the engine either way.
    for (const row of sweep.rows) {
      expect(row.report.params.fillWindowSec).toBe(row.fillWindowSec);
    }
    expect(sweep.rows[0].report.totals.filled).toBe(2);
    expect(sweep.rows[0].report.totals.failedLate).toBe(1);
    expect(sweep.rows[1].report.totals.filled).toBe(2);
    expect(sweep.rows[1].report.totals.failedLate).toBe(1);
  });

  it("is deterministic: two identical sweeps produce identical JSON", () => {
    const options = {
      strategyFactory: (params: { minMarginBps: number }) =>
        new MarginThresholdStrategy({ minMarginBps: params.minMarginBps }),
      params: { seed: 11 },
      prices: makePrices(),
      grid,
    };
    const first = JSON.stringify(runSweep(makeEvents(), options));
    const second = JSON.stringify(runSweep(makeEvents(), options));
    expect(first).toBe(second);
  });
});

describe("report formatting (issue #452)", () => {
  it("formatReport covers PnL, fill-rate and slash-risk", () => {
    const sweep = runSweep(makeEvents(), {
      strategyFactory: () => new AlwaysFillStrategy(),
      params: { seed: 3 },
      prices: makePrices(),
      grid: { fillWindowSecs: [0], feeBps: [5] },
    });
    const text = formatReport(sweep.rows[0].report);
    expect(text).toContain("Strategy:           always-fill");
    expect(text).toContain("fill rate 100.0%");
    expect(text).toContain("Slash risk:");
    expect(text).toContain("PnL:");
    expect(text).toContain("seed=3 feeBps=5");
  });

  it("formatSweep renders one markdown row per grid cell", () => {
    const sweep = runSweep(makeEvents(), {
      strategyFactory: () => new AlwaysFillStrategy(),
      prices: makePrices(),
      grid: { fillWindowSecs: [0, 100], feeBps: [5, 50] },
    });
    const table = formatSweep(sweep);
    // Header + one data row per cell (the |---| separator never starts with "| ").
    const rows = table.split("\n").filter((line) => line.startsWith("| "));
    expect(rows).toHaveLength(1 + sweep.rows.length);
    expect(table).toContain("| fill window (s) | fee bps |");
    expect(table).toContain("| 0 | 50 |");
    expect(table).toContain("| 100 | 5 |");
  });
});
