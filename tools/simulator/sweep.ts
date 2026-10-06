/**
 * Parameter sweep mode for the simulation harness (issue #452): replay the
 * same archive across a grid of protocol parameters — fill window × fee
 * bps — and produce a comparative report.
 */
import { ReplayEngine } from "./engine";
import type { EngineOptions } from "./engine";
import type { PriceBook } from "./prices";
import type { SimEvent, SimParams, SimReport, SimulatorStrategy } from "./types";
import { DEFAULT_SIM_PARAMS } from "./types";

/** Sweep axes; the grid is their Cartesian product. */
export interface SweepGrid {
  /** Fill-window values in seconds (`0` = deadline only). */
  fillWindowSecs: readonly number[];
  /** Protocol fee values in basis points. */
  feeBps: readonly number[];
}

/** One grid cell's outcome. */
export interface SweepRow {
  fillWindowSec: number;
  feeBps: number;
  report: SimReport;
}

/** Comparative result of a sweep, ordered window-major then fee bps. */
export interface SweepReport {
  strategy: string;
  seed: number;
  rows: SweepRow[];
}

/** Options for {@link runSweep}. */
export interface SweepOptions {
  /** Builds a fresh strategy per cell (strategies must not leak state between runs). */
  strategyFactory: (params: SimParams) => SimulatorStrategy;
  /** Base parameters; each cell overrides `fillWindowSec` and `feeBps`. */
  params?: Partial<SimParams>;
  prices?: PriceBook;
  grid: SweepGrid;
}

/**
 * Replay `events` once per grid cell.
 *
 * Events are parsed/normalized once and reused; each cell gets a fresh
 * engine (fresh counters, fresh seeded PRNG), so cells are independent and
 * the whole sweep is deterministic for a given seed.
 */
export function runSweep(events: readonly SimEvent[], options: SweepOptions): SweepReport {
  const base: SimParams = { ...DEFAULT_SIM_PARAMS, ...options.params };
  const rows: SweepRow[] = [];
  for (const fillWindowSec of options.grid.fillWindowSecs) {
    for (const feeBps of options.grid.feeBps) {
      const params: SimParams = { ...base, fillWindowSec, feeBps };
      const engineOptions: EngineOptions = {
        strategy: options.strategyFactory(params),
        params,
        prices: options.prices,
      };
      const report = new ReplayEngine(engineOptions).run(events);
      rows.push({ fillWindowSec, feeBps, report });
    }
  }
  return { strategy: options.strategyFactory(base).name, seed: base.seed, rows };
}
