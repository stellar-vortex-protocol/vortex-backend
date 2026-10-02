/**
 * Solver simulation & backtesting harness (issue #452).
 *
 * Replays archived intent/price streams against pluggable solver
 * strategies on a deterministic simulated clock, and reports PnL,
 * fill-rate and slash-risk — optionally across a fill-window × fee-bps
 * parameter sweep. Pure domain modules only (`src/auctions`, `src/fees`,
 * `src/routing`): no Nest bootstrap, no network, no wall clock.
 *
 * @example
 * ```ts
 * import { parseIntentEvents, ReplayEngine, AlwaysFillStrategy } from "./tools/simulator";
 *
 * const events = parseIntentEvents(archiveText);
 * const report = new ReplayEngine({ strategy: new AlwaysFillStrategy(), params: { seed: 7 } }).run(events);
 * ```
 */
export type {
  ArchivedIntent,
  QuoteDecision,
  SimEvent,
  SimEventKind,
  SimParams,
  SimReport,
  SimulatorStrategy,
  SimulationTotals,
  StrategyContext,
} from "./types";
export { DEFAULT_SIM_PARAMS } from "./types";
export { createPrng } from "./prng";
export { PriceBook } from "./prices";
export type { PricePoint, PriceRow } from "./prices";
export { generateSyntheticArchive, parseIntentEvents, parsePriceBook } from "./archive";
export { ReplayEngine } from "./engine";
export type { EngineOptions } from "./engine";
export { runSweep } from "./sweep";
export type { SweepGrid, SweepOptions, SweepReport, SweepRow } from "./sweep";
export { formatReport, formatSweep } from "./report";
export { AlwaysFillStrategy } from "./strategies/always-fill.strategy";
export type { AlwaysFillOptions } from "./strategies/always-fill.strategy";
export { MarginThresholdStrategy } from "./strategies/margin-threshold.strategy";
export type { MarginThresholdOptions } from "./strategies/margin-threshold.strategy";
export { attemptGateReason, effectiveDeadline } from "./strategies/gate";
export type { AttemptGate, GateReason } from "./strategies/gate";
export { runCli, USAGE } from "./cli";
export type { CliResult } from "./cli";
