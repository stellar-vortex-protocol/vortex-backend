/**
 * Core types for the solver simulation harness (issue #452).
 *
 * The harness replays an archived intent stream against a pluggable
 * strategy on a deterministic, simulated clock — no network, no Nest
 * bootstrap, no wall-clock reads. All randomness flows through the seeded
 * PRNG exposed on {@link StrategyContext}, so identical inputs and seed
 * always produce an identical {@link SimReport}.
 */
import type { DutchAuction } from "../../src/auctions/dutch";
import type { FeeQuote, FeeRule } from "../../src/fees/fee-engine";
import { SUPPORTED_CHAINS } from "../../src/intents/intents.types";
import type { Route } from "../../src/intents/intents.types";
import type { PriceBook } from "./prices";

/** Which strategy hook an archived event is dispatched to. */
export type SimEventKind = "intent" | "quote_request";

/**
 * One row of the archived intent stream. Field names intentionally mirror
 * the public `intents` dataset schema (`src/datasets/schemas.ts`) so rows
 * exported by `npm run export:datasets` can be replayed with minimal
 * reshaping; timestamps are Unix epoch seconds.
 */
export interface ArchivedIntent {
  intentId: string;
  /** Creation time — the simulated clock position of this event. */
  createdAt: number;
  /** Unix seconds after which the intent can no longer be filled. */
  deadline: number;
  srcChain: string;
  /** Source contract / mint address. */
  srcToken?: string;
  srcTokenSymbol?: string;
  /** Source amount in base units. */
  srcAmount: string;
  /** Destination contract / mint address (Stellar). */
  dstToken?: string;
  dstTokenSymbol?: string;
  /** Minimum the user must receive, in dst-token base units. */
  minDstAmount: string;
  /** Destination chain; defaults to `stellar`. */
  dstChain?: string;
  /**
   * Intent state as-of the event. Strategies may ignore it (see
   * `AttemptGate.ignoreState`) — replay rows usually describe the creation
   * moment, so the default is `open`.
   */
  state?: string;
  /** Source-leg USD value captured at creation, when the archive has it. */
  usdValueAtCreate?: number;
  /** Dutch auction attached to the intent, if any. */
  auction?: DutchAuction;
  /** Dispatch selector; defaults to `"intent"`. */
  event?: SimEventKind;
}

/** A single archived event: intent delivery at simulated time `ts`. */
export interface SimEvent {
  ts: number;
  intent: ArchivedIntent;
}

/**
 * A strategy's answer to a quote. `null` declines. A returned decision
 * schedules a fill at `now + fillDelayMs`; the engine enforces the fill
 * window and the intent deadline.
 */
export interface QuoteDecision {
  /** Dst-token base units the solver commits to deliver. Must be ≥ `minDstAmount`. */
  dstAmount: string;
  /** Simulated latency from decision to fill. Defaults to `0`. */
  fillDelayMs?: number;
}

/** Protocol parameters the harness evaluates (sweepable — see `sweep.ts`). */
export interface SimParams {
  /** PRNG seed for {@link StrategyContext.random}. */
  seed: number;
  /** Protocol fee in basis points applied to fills (via `src/fees`). */
  feeBps: number;
  /**
   * Fill window in seconds from intent creation. `0` disables the window
   * and only the intent's own deadline constrains fills.
   */
  fillWindowSec: number;
  /** Chains the simulated solver trades. */
  chains: readonly string[];
  /** Default margin threshold (bps) handed to margin-style strategies. */
  minMarginBps: number;
  /** USD penalty charged per accepted-but-unfilled intent (models a bond slash). */
  slashPenaltyUsd: number;
  /** Flat USD settlement cost per fill. */
  gasUsdPerFill: number;
}

/** Default protocol parameters used when none are supplied. */
export const DEFAULT_SIM_PARAMS: SimParams = {
  seed: 42,
  feeBps: 5,
  fillWindowSec: 0,
  chains: [...SUPPORTED_CHAINS],
  minMarginBps: 0,
  slashPenaltyUsd: 100,
  gasUsdPerFill: 0,
};

/**
 * Everything a strategy may read while deciding. The engine reuses a
 * single context object across the run and mutates `nowSec` — strategies
 * must not retain the context after a hook returns.
 */
export interface StrategyContext {
  /** Current simulated time (Unix seconds of the event being dispatched). */
  nowSec: number;
  params: SimParams;
  prices: PriceBook;
  feeRules: readonly FeeRule[];
  /** Deterministic PRNG in `[0, 1)` seeded from `params.seed`. */
  random(): number;
  /** Build the routing module's estimate for settling this intent. */
  route(intent: ArchivedIntent): Route;
  /** Quote the protocol fee for delivering `amount` dst base units. */
  fee(amount: string, intent: ArchivedIntent): FeeQuote;
  /** USD value of `amount` of `chain`/`symbol` at time `ts`, or null when unknown. */
  valueUsd(chain: string, symbol: string, amountBase: string, ts: number): number | null;
}

/**
 * A pluggable solver strategy under test (issue #452). The three hooks are
 * the contract every strategy — the two reference implementations in
 * `strategies/` included — must implement.
 */
export interface SimulatorStrategy {
  readonly name: string;
  /** A new intent arrived on the feed. Return a quote or `null` to decline. */
  onIntent(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null;
  /** The protocol asked this solver for a quote (RFQ round). */
  onQuoteRequest(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null;
  /** The simulated clock advanced to `nowSec`. */
  onTick(ctx: StrategyContext, nowSec: number): void;
}

/** Aggregated outcome of one replay — the report the issue asks for. */
export interface SimulationTotals {
  /** Total events replayed. */
  events: number;
  /** Events dispatched to `onIntent`. */
  intentEvents: number;
  /** Events dispatched to `onQuoteRequest`. */
  quoteRequests: number;
  quotesDeclined: number;
  quotesSubmitted: number;
  filled: number;
  /** Accepted but never filled (counted regardless of reason). */
  failedFills: number;
  failedLate: number;
  failedBelowMin: number;
  /** Unfilled acceptances — the slash-risk event count. */
  slashEvents: number;
  slashPenaltyUsd: number;
  /** `filled / quotesSubmitted`. */
  fillRate: number;
  /** `filled / intentEvents`. */
  captureRate: number;
  volumeUsd: number;
  pnlUsd: number;
  feesPaidUsd: number;
  gasPaidUsd: number;
  /** Fills whose USD legs could not be priced (excluded from USD totals). */
  unknownPriceFills: number;
  avgFillLatencyMs: number;
}

/** Full replay result: strategy identity + parameters + totals. */
export interface SimReport {
  strategy: string;
  params: SimParams;
  totals: SimulationTotals;
}
