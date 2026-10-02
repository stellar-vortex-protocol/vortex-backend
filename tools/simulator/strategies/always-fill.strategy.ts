/**
 * Reference strategy #1 for the simulation harness (issue #452):
 * accept-everything — the exact behaviour `scripts/solver-bot.ts` runs in
 * live demos, extracted so it can be replayed offline.
 *
 * Quotes `minDstAmount` and fills immediately for every intent that clears
 * the shared gate (chains + optional absolute margin + live deadline).
 */
import type {
  ArchivedIntent,
  QuoteDecision,
  SimulatorStrategy,
  StrategyContext,
} from "../types";
import { attemptGateReason } from "./gate";

/** Tuning for {@link AlwaysFillStrategy}. */
export interface AlwaysFillOptions {
  /** Override the chain allowlist (defaults to `ctx.params.chains`). */
  chains?: readonly string[];
  /** Absolute-margin heuristic in bps; `0` disables it (the bot's default). */
  minMarginBps?: number;
}

/**
 * The naive "fill every open intent at `minDstAmount`" strategy.
 *
 * Deterministic: no prices, no fees, no randomness — the harness's
 * baseline for comparing smarter strategies and for parameter sweeps.
 */
export class AlwaysFillStrategy implements SimulatorStrategy {
  readonly name = "always-fill";

  constructor(private readonly options: AlwaysFillOptions = {}) {}

  /** @inheritdoc */
  onIntent(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null {
    return this.decide(ctx, intent);
  }

  /** @inheritdoc — RFQ rounds get the same answer as broadcast intents. */
  onQuoteRequest(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null {
    return this.decide(ctx, intent);
  }

  /** @inheritdoc — this strategy observes no time-based signal. */
  onTick(_ctx: StrategyContext, _nowSec: number): void {
    /* no time-dependent behaviour */
  }

  private decide(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null {
    const reason = attemptGateReason(intent, {
      chains: this.options.chains ?? ctx.params.chains,
      minMarginBps: this.options.minMarginBps ?? 0,
      nowSec: ctx.nowSec,
      ignoreState: true,
    });
    if (reason !== null) return null;
    return { dstAmount: intent.minDstAmount, fillDelayMs: 0 };
  }
}
