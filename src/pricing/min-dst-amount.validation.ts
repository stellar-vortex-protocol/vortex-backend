/**
 * Oracle-referenced minDstAmount validation (issue #434).
 *
 * Pure functions over an injected {@link PriceSnapshot} so unit tests can
 * pin fair value, slippage, and fail-open/fail-closed behaviour without a
 * live aggregator.
 *
 * All arithmetic is `bigint`. USD prices are scaled by {@link USD_PRICE_SCALE}
 * (8 decimal places) so 6/7/18-decimal token pairs never pass through
 * IEEE-754 money math.
 */

import { assertValidDecimals, parseBaseUnits } from "../common/amount";

/** 1 USD = 10^8 scaled units. */
export const USD_PRICE_SCALE = 100_000_000n;

export type OracleMinDstConfig = {
  /** Reject minDst below fair by more than this many bps unless acknowledged. */
  maxUserSlippageBps: bigint;
  /** Reject minDst above fair by more than this many bps. */
  maxPremiumBps: bigint;
  /**
   * When the oracle is unavailable, intents whose source notional is at most
   * this many scaled USD units may still be created (fail-open).
   */
  failOpenMaxUsd: bigint;
  /** Snapshots older than this are treated as unavailable. */
  maxStalenessMs: number;
};

export type PriceSnapshot = {
  /** Source token USD price in {@link USD_PRICE_SCALE} units, or null if unknown. */
  srcPriceUsd: bigint | null;
  /** Destination token USD price in {@link USD_PRICE_SCALE} units, or null if unknown. */
  dstPriceUsd: bigint | null;
  /** Unix epoch milliseconds when this snapshot was taken. */
  asOfMs: number;
};

export type MinDstValidationInput = {
  srcAmount: string | bigint;
  srcDecimals: number;
  dstDecimals: number;
  minDstAmount: string | bigint;
  acknowledgeHighSlippage: boolean;
  nowMs: number;
  snapshot: PriceSnapshot;
};

export type MinDstValidationOk = {
  ok: true;
  fairValue: bigint | null;
  slippageBps: bigint;
  premiumBps: bigint;
  oracleUnavailable: boolean;
};

export type MinDstValidationErr = {
  ok: false;
  code:
    | "INVALID_AMOUNT"
    | "ORACLE_UNAVAILABLE"
    | "STALE_ORACLE"
    | "EXCESSIVE_SLIPPAGE"
    | "EXCESSIVE_PREMIUM";
  error: string;
  fairValue?: bigint;
  slippageBps?: bigint;
  premiumBps?: bigint;
};

export type MinDstValidationResult = MinDstValidationOk | MinDstValidationErr;

/**
 * Encode a finite non-negative USD price as {@link USD_PRICE_SCALE} units.
 *
 * Uses a fixed 8-decimal string so values such as `0.1182` and `3512.80`
 * round-trip without binary float drift in the integer domain.
 */
export function usdPriceToScale(price: number): bigint | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const fixed = price.toFixed(8);
  const [whole, fractionRaw = ""] = fixed.split(".");
  const fraction = fractionRaw.padEnd(8, "0").slice(0, 8);
  return BigInt(whole) * USD_PRICE_SCALE + BigInt(fraction);
}

/**
 * Fair destination amount in dst base units:
 * `srcAmount * srcPrice * 10^dstDecimals / (dstPrice * 10^srcDecimals)`.
 *
 * Division floors. That under-states fair value by at most 1 dst base unit,
 * which is user-protective (reported slippage is never smaller than actual).
 */
export function computeFairDstAmount(
  srcAmount: bigint,
  srcDecimals: number,
  dstDecimals: number,
  srcPriceUsd: bigint,
  dstPriceUsd: bigint,
): bigint {
  assertValidDecimals(srcDecimals);
  assertValidDecimals(dstDecimals);
  if (srcAmount < 0n || srcPriceUsd <= 0n || dstPriceUsd <= 0n) {
    throw new RangeError("fair-value inputs must be non-negative with positive prices");
  }
  const numerator = srcAmount * srcPriceUsd * 10n ** BigInt(dstDecimals);
  const denominator = dstPriceUsd * 10n ** BigInt(srcDecimals);
  return numerator / denominator;
}

/** Source notional in {@link USD_PRICE_SCALE} USD units. */
export function sourceNotionalUsd(
  srcAmount: bigint,
  srcDecimals: number,
  srcPriceUsd: bigint,
): bigint {
  return (srcAmount * srcPriceUsd) / 10n ** BigInt(srcDecimals);
}

function snapshotUnavailable(snapshot: PriceSnapshot, nowMs: number, maxStalenessMs: number): boolean {
  if (snapshot.srcPriceUsd === null || snapshot.dstPriceUsd === null) return true;
  if (snapshot.srcPriceUsd <= 0n || snapshot.dstPriceUsd <= 0n) return true;
  if (nowMs - snapshot.asOfMs > maxStalenessMs) return true;
  return false;
}

/**
 * Validate `minDstAmount` against an oracle fair value.
 *
 * @param input Amounts, decimals, acknowledgement flag, and price snapshot.
 * @param config Slippage / premium / fail-open thresholds.
 */
export function validateMinDstAmount(
  input: MinDstValidationInput,
  config: OracleMinDstConfig,
): MinDstValidationResult {
  let srcAmount: bigint;
  let minDstAmount: bigint;
  try {
    srcAmount = parseBaseUnits(input.srcAmount);
    minDstAmount = parseBaseUnits(input.minDstAmount);
    assertValidDecimals(input.srcDecimals);
    assertValidDecimals(input.dstDecimals);
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: err instanceof Error ? err.message : "invalid amount",
    };
  }

  if (srcAmount === 0n || minDstAmount === 0n) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: "srcAmount and minDstAmount must be positive",
    };
  }

  const stale = input.nowMs - input.snapshot.asOfMs > config.maxStalenessMs;
  const missingPrice =
    input.snapshot.srcPriceUsd === null ||
    input.snapshot.dstPriceUsd === null ||
    input.snapshot.srcPriceUsd <= 0n ||
    input.snapshot.dstPriceUsd <= 0n;

  if (snapshotUnavailable(input.snapshot, input.nowMs, config.maxStalenessMs)) {
    const srcPrice = input.snapshot.srcPriceUsd;
    if (srcPrice !== null && srcPrice > 0n) {
      const notional = sourceNotionalUsd(srcAmount, input.srcDecimals, srcPrice);
      if (notional <= config.failOpenMaxUsd) {
        return {
          ok: true,
          fairValue: null,
          slippageBps: 0n,
          premiumBps: 0n,
          oracleUnavailable: true,
        };
      }
    }
    return {
      ok: false,
      code: stale && !missingPrice ? "STALE_ORACLE" : "ORACLE_UNAVAILABLE",
      error: stale && !missingPrice
        ? "Oracle price snapshot is stale; minDstAmount cannot be validated"
        : "Oracle prices unavailable; minDstAmount cannot be validated",
    };
  }

  const fairValue = computeFairDstAmount(
    srcAmount,
    input.srcDecimals,
    input.dstDecimals,
    input.snapshot.srcPriceUsd as bigint,
    input.snapshot.dstPriceUsd as bigint,
  );

  if (fairValue === 0n) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: "oracle fair destination amount is zero",
      fairValue,
    };
  }

  const slippageBps = minDstAmount < fairValue ? ((fairValue - minDstAmount) * 10_000n) / fairValue : 0n;
  const premiumBps = minDstAmount > fairValue ? ((minDstAmount - fairValue) * 10_000n) / fairValue : 0n;

  if (slippageBps > config.maxUserSlippageBps && !input.acknowledgeHighSlippage) {
    return {
      ok: false,
      code: "EXCESSIVE_SLIPPAGE",
      error: `minDstAmount implies ${slippageBps} bps of slippage against oracle fair value ${fairValue}; max allowed is ${config.maxUserSlippageBps} bps (set acknowledgeHighSlippage and sign to proceed)`,
      fairValue,
      slippageBps,
      premiumBps,
    };
  }

  if (premiumBps > config.maxPremiumBps) {
    return {
      ok: false,
      code: "EXCESSIVE_PREMIUM",
      error: `minDstAmount implies ${premiumBps} bps above oracle fair value ${fairValue}; max premium is ${config.maxPremiumBps} bps`,
      fairValue,
      slippageBps,
      premiumBps,
    };
  }

  return {
    ok: true,
    fairValue,
    slippageBps,
    premiumBps,
    oracleUnavailable: false,
  };
}
