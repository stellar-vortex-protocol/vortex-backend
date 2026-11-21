/**
 * Size-aware price-impact model.
 *
 * The legacy quote path computed `priceImpact` as a flat spread:
 *   impact = 1 - (dstUsdValue / srcUsdValue)
 * which only reflects whatever spread the solver's quoted `dstAmount` already
 * implies and is completely independent of trade size. This module adds a
 * size-dependent component on top of that spread using a configurable
 * square-root-of-size curve against a liquidity hint.
 *
 * Conventions (mirroring `min-dst-amount.validation.ts`):
 * - USD-scaled values are plain `number`s (dollars, not base units).
 * - Base-unit amounts are `bigint` and are NOT accepted here; callers must
 *   convert to USD before calling.
 */

/**
 * Default liquidity depth (in USD) assumed when a caller has no hint. A hint
 * of zero / undefined / non-finite degrades to the flat-spread fallback.
 */
export const DEFAULT_PAIR_LIQUIDITY_HINT_USD = 0;

/**
 * Curve coefficient. Impact from size is `COEFFICIENT * sqrt(notional / liquidity)`.
 * Configurable so operators can tune the heuristic without code changes.
 */
export const DEFAULT_PRICE_IMPACT_COEFFICIENT = 0.1;

/**
 * Hard cap so a pathological notional/liquidity ratio cannot produce an
 * impact above 100%.
 */
export const MAX_PRICE_IMPACT = 1;

export interface EstimatePriceImpactParams {
  /** Trade notional in USD (plain number, dollars). */
  srcNotionalUsd: number;
  /**
   * Optional liquidity depth hint for the pair in USD (plain number, dollars).
   * Zero / missing / non-finite degrades to the flat-spread fallback.
   */
  pairLiquidityHint?: number | null;
  /**
   * Flat spread implied by the solver quote, i.e. `1 - dstUsdValue / srcUsdValue`.
   * Used as the liquidity-unaware fallback and as the base of the size curve.
   */
  flatSpread?: number;
  /** Optional override for the curve coefficient. */
  coefficient?: number;
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clampImpact(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value > MAX_PRICE_IMPACT ? MAX_PRICE_IMPACT : value;
}

/**
 * Estimate price impact for a trade.
 *
 * When a positive, finite liquidity hint is supplied, the result is the flat
 * solver spread plus a square-root-of-size component:
 *
 *   impact = flatSpread + coefficient * sqrt(srcNotionalUsd / pairLiquidityHint)
 *
 * When no usable hint is supplied, the function degrades gracefully to the
 * legacy flat-spread number (never throws, never returns NaN).
 */
export function estimatePriceImpact(params: EstimatePriceImpactParams): number {
  const { srcNotionalUsd, pairLiquidityHint, flatSpread, coefficient } = params;

  const baseSpread = isFinitePositive(flatSpread) || flatSpread === 0 ? flatSpread : 0;

  if (!isFinitePositive(pairLiquidityHint) || !isFinitePositive(srcNotionalUsd)) {
    return clampImpact(baseSpread);
  }

  const coeff = isFinitePositive(coefficient)
    ? coefficient
    : DEFAULT_PRICE_IMPACT_COEFFICIENT;

  const sizeComponent = coeff * Math.sqrt(srcNotionalUsd / pairLiquidityHint);
  return clampImpact(baseSpread + sizeComponent);
}

/**
 * Convenience helper matching the issue's suggested signature. Computes the
 * flat spread from USD values and delegates to `estimatePriceImpact`.
 */
export function estimatePriceImpactFromUsdValues(
  srcNotionalUsd: number,
  srcUsdValue: number,
  dstUsdValue: number,
  pairLiquidityHint?: number | null,
  coefficient?: number,
): number {
  const flatSpread =
    isFinitePositive(srcUsdValue) && Number.isFinite(dstUsdValue)
      ? 1 - dstUsdValue / srcUsdValue
      : 0;

  return estimatePriceImpact({
    srcNotionalUsd,
    pairLiquidityHint,
    flatSpread,
    coefficient,
  });
}
