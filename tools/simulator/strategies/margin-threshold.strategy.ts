/**
 * Reference strategy #2 for the simulation harness (issue #452):
 * price-aware margin thresholding with optional Dutch-auction sniping.
 *
 * Values both legs in USD (archived prices or `usdValueAtCreate`), quotes
 * the protocol fee through `src/fees`, checks settlement feasibility
 * through `src/routing`, and — when the intent carries an auction — waits
 * for `src/auctions`' decay to push the margin over the threshold before
 * filling. Declines whenever economics are unknown: never guess a price.
 */
import { dutchAuctionPrice } from "../../../src/auctions/dutch";
import type {
  ArchivedIntent,
  QuoteDecision,
  SimulatorStrategy,
  StrategyContext,
} from "../types";
import { attemptGateReason, effectiveDeadline } from "./gate";

/** Tuning for {@link MarginThresholdStrategy}. */
export interface MarginThresholdOptions {
  /** Threshold in bps of the source-leg value; defaults to `ctx.params.minMarginBps`. */
  minMarginBps?: number;
  /** Override the chain allowlist (defaults to `ctx.params.chains`). */
  chains?: readonly string[];
  /** Wait for Dutch-auction decay to improve the margin before filling. */
  useAuction?: boolean;
}

/** A chosen fill: when to fill and at what dst amount. */
interface FillPlan {
  delaySec: number;
  dstAmount: string;
}

/**
 * Quote only when the trade clears a margin threshold after protocol fees.
 *
 * All arithmetic is deterministic (no randomness, integer-second auction
 * search), so the strategy is directly comparable across sweep cells.
 */
export class MarginThresholdStrategy implements SimulatorStrategy {
  readonly name = "margin-threshold";

  constructor(private readonly options: MarginThresholdOptions = {}) {}

  /** @inheritdoc */
  onIntent(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null {
    return this.decide(ctx, intent);
  }

  /** @inheritdoc */
  onQuoteRequest(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null {
    return this.decide(ctx, intent);
  }

  /** @inheritdoc — this strategy plans waits at decision time, not per tick. */
  onTick(_ctx: StrategyContext, _nowSec: number): void {
    /* no time-dependent behaviour */
  }

  private decide(ctx: StrategyContext, intent: ArchivedIntent): QuoteDecision | null {
    const threshold = this.options.minMarginBps ?? ctx.params.minMarginBps;
    const reason = attemptGateReason(intent, {
      chains: this.options.chains ?? ctx.params.chains,
      minMarginBps: 0,
      nowSec: ctx.nowSec,
      ignoreState: true,
    });
    if (reason !== null) return null;

    const srcUsd = this.srcValueUsd(ctx, intent);
    if (srcUsd === null || srcUsd <= 0) return null; // unknown economics → decline

    const plan =
      this.options.useAuction && intent.auction
        ? this.planAuctionFill(ctx, intent, srcUsd, threshold)
        : this.planImmediateFill(ctx, intent, srcUsd, threshold);
    if (plan === null) return null;

    // Settlement must fit inside the fill window (routing module estimate).
    const route = ctx.route(intent);
    if (ctx.nowSec + plan.delaySec + route.totalTime > effectiveDeadline(intent, ctx.params.fillWindowSec)) {
      return null;
    }
    return { dstAmount: plan.dstAmount, fillDelayMs: plan.delaySec * 1_000 };
  }

  /** Source-leg USD value: captured-at-creation first, archived prices second. */
  private srcValueUsd(ctx: StrategyContext, intent: ArchivedIntent): number | null {
    if (intent.usdValueAtCreate !== undefined) return intent.usdValueAtCreate;
    return ctx.valueUsd(intent.srcChain, intent.srcTokenSymbol ?? "", intent.srcAmount, intent.createdAt);
  }

  /**
   * Margin (bps of the source leg) of delivering `dstAmount`.
   *
   * `null` when the destination leg cannot be priced.
   */
  private marginBps(
    ctx: StrategyContext,
    intent: ArchivedIntent,
    dstAmount: string,
    srcUsd: number,
  ): number | null {
    const dstUsd = ctx.valueUsd(intent.dstChain ?? "stellar", intent.dstTokenSymbol ?? "", dstAmount, intent.createdAt);
    if (dstUsd === null) return null;
    const dstUnits = Number(dstAmount);
    if (!Number.isFinite(dstUnits) || dstUnits <= 0) return null;
    const fee = ctx.fee(dstAmount, intent);
    const feeUsd = dstUsd * (Number(fee.fee) / dstUnits);
    return ((srcUsd - dstUsd - feeUsd) / srcUsd) * 10_000;
  }

  private planImmediateFill(
    ctx: StrategyContext,
    intent: ArchivedIntent,
    srcUsd: number,
    threshold: number,
  ): FillPlan | null {
    const margin = this.marginBps(ctx, intent, intent.minDstAmount, srcUsd);
    if (margin === null || margin < threshold) return null;
    return { delaySec: 0, dstAmount: intent.minDstAmount };
  }

  /**
   * Find the earliest integer-second moment (≥ now) where the decaying
   * auction price clears the margin threshold. Margin is monotonic
   * non-decreasing as the auction decays (the solver delivers less), so a
   * binary search over the decay range is exact.
   *
   * @returns The fill plan, or `null` when even full decay misses the threshold.
   */
  private planAuctionFill(
    ctx: StrategyContext,
    intent: ArchivedIntent,
    srcUsd: number,
    threshold: number,
  ): FillPlan | null {
    const auction = intent.auction;
    if (!auction) return null;
    const loSec = ctx.nowSec;
    const hiSec = Math.min(auction.decayEnd, effectiveDeadline(intent, ctx.params.fillWindowSec));
    const priceAt = (ts: number): string =>
      dutchAuctionPrice(auction, ts, intent.minDstAmount);
    const marginAt = (ts: number): number | null =>
      this.marginBps(ctx, intent, priceAt(ts), srcUsd);

    // Fully decayed must still clear the threshold, else decline.
    const endMargin = marginAt(hiSec);
    if (endMargin === null || endMargin < threshold) return null;
    const startMargin = marginAt(loSec);
    if (startMargin === null) return null;
    if (startMargin >= threshold) return { delaySec: 0, dstAmount: priceAt(loSec) };

    let low = loSec;
    let high = hiSec;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const margin = marginAt(mid);
      if (margin !== null && margin >= threshold) high = mid;
      else low = mid + 1;
    }
    const dstAmount = priceAt(low);
    // Re-verify: quantised fees can leave the boundary short in theory.
    const finalMargin = marginAt(low);
    if (finalMargin === null || finalMargin < threshold) return null;
    return { delaySec: low - loSec, dstAmount };
  }
}
