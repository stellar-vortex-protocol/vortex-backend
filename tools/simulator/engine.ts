/**
 * Deterministic replay engine for the solver simulation harness (issue #452).
 *
 * The engine walks an archived intent stream on a simulated clock — event
 * timestamps only, never `Date.now()` — completing scheduled fills,
 * dispatching to the strategy's `onIntent` / `onQuoteRequest` / `onTick`
 * hooks, and pricing fills through the pure domain modules:
 *
 * - `src/fees`    — protocol fee per fill (`quoteFee`)
 * - `src/routing` — settlement-time feasibility (`RoutingService.buildRoute`)
 * - `src/auctions` — Dutch-auction decay (used by the margin strategy)
 *
 * No Nest bootstrap: everything is plain construction over pure modules.
 * A fill whose simulated time passes the effective deadline (`intent
 * deadline`, tightened by `fillWindowSec`) becomes a failed fill and a
 * slash-risk event; a quote below `minDstAmount` fails the same way.
 */
import { RoutingService } from "../../src/routing/routing.service";
import { DEFAULT_FEE_RULE, quoteFee } from "../../src/fees/fee-engine";
import type { FeeRule } from "../../src/fees/fee-engine";
import type { Route, SupportedChain } from "../../src/intents/intents.types";
import { createPrng } from "./prng";
import { PriceBook } from "./prices";
import type {
  ArchivedIntent,
  QuoteDecision,
  SimEvent,
  SimParams,
  SimReport,
  SimulationTotals,
  StrategyContext,
  SimulatorStrategy,
} from "./types";
import { DEFAULT_SIM_PARAMS } from "./types";
import { effectiveDeadline } from "./strategies/gate";

/** Options for one replay. */
export interface EngineOptions {
  strategy: SimulatorStrategy;
  /** Partial parameters; merged over {@link DEFAULT_SIM_PARAMS}. */
  params?: Partial<SimParams>;
  /** Archived prices; an empty book makes all price-dependent economics "unknown". */
  prices?: PriceBook;
}

/** A scheduled fill awaiting settlement. */
interface PendingFill {
  fillAtSec: number;
  quotedAtSec: number;
  intent: ArchivedIntent;
  dstAmount: string;
}

/**
 * Binary min-heap over `fillAtSec`, so scheduled fills settle in time
 * order without rescanning the pending set on every event (keeps the
 * 1M-intent budget comfortably inside 5 minutes).
 */
class FillHeap {
  private readonly items: PendingFill[] = [];

  push(item: PendingFill): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].fillAtSec <= items[i].fillAtSec) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  peek(): PendingFill | undefined {
    return this.items[0];
  }

  pop(): PendingFill | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as PendingFill;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].fillAtSec < items[smallest].fillAtSec) smallest = left;
        if (right < items.length && items[right].fillAtSec < items[smallest].fillAtSec) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Replays archived events against one strategy.
 *
 * @example
 * ```ts
 * const engine = new ReplayEngine({ strategy: new AlwaysFillStrategy(), params: { seed: 7 } });
 * const report = engine.run(parseIntentEvents(archiveText));
 * ```
 */
export class ReplayEngine {
  private readonly strategy: SimulatorStrategy;
  private readonly params: SimParams;
  private readonly prices: PriceBook;
  private readonly feeRules: readonly FeeRule[];
  private readonly routing = new RoutingService();
  private readonly random: () => number;

  constructor(options: EngineOptions) {
    this.strategy = options.strategy;
    this.params = { ...DEFAULT_SIM_PARAMS, ...options.params };
    this.prices = options.prices ?? new PriceBook();
    this.feeRules = [{ ...DEFAULT_FEE_RULE, id: "sim-default", bps: this.params.feeBps }];
    this.random = createPrng(this.params.seed);
  }

  /**
   * Replay `events` in timestamp order and return the aggregated report.
   *
   * The input array is not mutated; events with equal timestamps keep
   * their relative input order (stable sort), which keeps replays
   * deterministic.
   */
  run(events: readonly SimEvent[]): SimReport {
    const sorted: SimEvent[] = [...events].sort((a, b) => a.ts - b.ts);
    const heap = new FillHeap();
    const ctx: StrategyContext = {
      nowSec: 0,
      params: this.params,
      prices: this.prices,
      feeRules: this.feeRules,
      random: this.random,
      route: (intent) => this.routeFor(intent),
      fee: (amount, intent) =>
        quoteFee(this.feeRules, [], {
          amount,
          srcChain: intent.srcChain,
          dstChain: intent.dstChain ?? "stellar",
        }),
      valueUsd: (chain, symbol, amountBase, ts) => this.prices.usdValue(chain, symbol, amountBase, ts),
    };

    const totals = emptyTotals();
    let lastTs = Number.NEGATIVE_INFINITY;

    for (const event of sorted) {
      // 1. Settle everything due at or before this moment.
      while (heap.peek() && (heap.peek() as PendingFill).fillAtSec <= event.ts) {
        this.settle(heap.pop() as PendingFill, totals);
      }
      // 2. The clock advanced → tick, then dispatch.
      ctx.nowSec = event.ts;
      if (event.ts > lastTs) this.strategy.onTick(ctx, event.ts);
      lastTs = event.ts;
      this.dispatch(event, ctx, heap, totals);
    }
    // 3. Stream over: settle the remainder (late vs on-time is decided per fill).
    for (;;) {
      const pending = heap.pop();
      if (!pending) break;
      this.settle(pending, totals);
    }

    return finalizeReport(this.strategy.name, this.params, totals);
  }

  private dispatch(
    event: SimEvent,
    ctx: StrategyContext,
    heap: FillHeap,
    totals: SimulationTotals,
  ): void {
    const intent = event.intent;
    totals.events += 1;
    const kind = intent.event ?? "intent";
    let decision: QuoteDecision | null;
    if (kind === "quote_request") {
      totals.quoteRequests += 1;
      decision = this.strategy.onQuoteRequest(ctx, intent);
    } else {
      totals.intentEvents += 1;
      decision = this.strategy.onIntent(ctx, intent);
    }
    if (decision === null) {
      totals.quotesDeclined += 1;
      return;
    }
    totals.quotesSubmitted += 1;
    const dstUnits = safeBigint(decision.dstAmount);
    const minUnits = safeBigint(intent.minDstAmount);
    if (dstUnits === null || minUnits === null || dstUnits < minUnits) {
      // A quote below minDstAmount can never fill — failed + slash now.
      totals.failedFills += 1;
      totals.failedBelowMin += 1;
      this.chargeSlash(totals);
      return;
    }
    const delayMs = Math.max(0, decision.fillDelayMs ?? 0);
    heap.push({
      fillAtSec: event.ts + delayMs / 1_000,
      quotedAtSec: event.ts,
      intent,
      dstAmount: decision.dstAmount,
    });
  }

  private settle(pending: PendingFill, totals: SimulationTotals): void {
    const deadline = effectiveDeadline(pending.intent, this.params.fillWindowSec);
    if (pending.fillAtSec > deadline) {
      totals.failedFills += 1;
      totals.failedLate += 1;
      this.chargeSlash(totals);
      return;
    }

    totals.filled += 1;
    totals.avgFillLatencyMs += (pending.fillAtSec - pending.quotedAtSec) * 1_000;

    const intent = pending.intent;
    const fee = quoteFee(this.feeRules, [], {
      amount: pending.dstAmount,
      srcChain: intent.srcChain,
      dstChain: intent.dstChain ?? "stellar",
    });

    // USD legs: captured-at-creation value first, archived price second.
    const srcUsd =
      intent.usdValueAtCreate !== undefined
        ? intent.usdValueAtCreate
        : this.prices.usdValue(intent.srcChain, intent.srcTokenSymbol ?? "", intent.srcAmount, intent.createdAt);
    const dstUsd = this.prices.usdValue(
      intent.dstChain ?? "stellar",
      intent.dstTokenSymbol ?? "",
      pending.dstAmount,
      intent.createdAt,
    );

    if (srcUsd === null || dstUsd === null) {
      // Unknown economics: count the fill, contribute no USD figures.
      totals.unknownPriceFills += 1;
      return;
    }

    const dstUnits = Number(pending.dstAmount);
    const feeUsd = Number.isFinite(dstUnits) && dstUnits > 0 ? dstUsd * (Number(fee.fee) / dstUnits) : 0;
    totals.volumeUsd += srcUsd;
    totals.feesPaidUsd += feeUsd;
    totals.gasPaidUsd += this.params.gasUsdPerFill;
    totals.pnlUsd += srcUsd - dstUsd - feeUsd - this.params.gasUsdPerFill;
  }

  private chargeSlash(totals: SimulationTotals): void {
    totals.slashEvents += 1;
    totals.slashPenaltyUsd += this.params.slashPenaltyUsd;
  }

  /** Direct two-hop-or-single route estimate from the pure routing module. */
  private routeFor(intent: ArchivedIntent): Route {
    return this.routing.buildRoute(
      {
        address: intent.srcToken ?? "",
        symbol: intent.srcTokenSymbol ?? "",
        name: intent.srcTokenSymbol ?? "",
        decimals: 18,
        chain: intent.srcChain as SupportedChain,
      },
      {
        address: intent.dstToken ?? "",
        symbol: intent.dstTokenSymbol ?? "",
        name: intent.dstTokenSymbol ?? "",
        decimals: 7,
        chain: "stellar",
      },
      "SIM_SOLVER",
      { totalFeesUSD: 0, priceImpact: 0, estimatedFillTime: 60 },
    );
  }
}

function emptyTotals(): SimulationTotals {
  return {
    events: 0,
    intentEvents: 0,
    quoteRequests: 0,
    quotesDeclined: 0,
    quotesSubmitted: 0,
    filled: 0,
    failedFills: 0,
    failedLate: 0,
    failedBelowMin: 0,
    slashEvents: 0,
    slashPenaltyUsd: 0,
    fillRate: 0,
    captureRate: 0,
    volumeUsd: 0,
    pnlUsd: 0,
    feesPaidUsd: 0,
    gasPaidUsd: 0,
    unknownPriceFills: 0,
    avgFillLatencyMs: 0,
  };
}

function finalizeReport(strategy: string, params: SimParams, totals: SimulationTotals): SimReport {
  totals.fillRate = totals.quotesSubmitted > 0 ? totals.filled / totals.quotesSubmitted : 0;
  totals.captureRate = totals.intentEvents > 0 ? totals.filled / totals.intentEvents : 0;
  totals.avgFillLatencyMs = totals.filled > 0 ? totals.avgFillLatencyMs / totals.filled : 0;
  return { strategy, params, totals };
}

function safeBigint(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
