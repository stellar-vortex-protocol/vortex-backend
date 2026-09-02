/**
 * Shared helpers for base-unit ↔ decimal amount conversion and the protocol's
 * fee / quote-variance arithmetic.
 *
 * Why this module exists
 * ----------------------
 * `IntentsController.quote()` and `fill()` each grew their own inline copy of
 * `BigInt` arithmetic and `Number(x) / Math.pow(10, decimals)` scaling.
 * `CHANGELOG.md` already records one *"Precision loss in quote calculation for
 * large bigint amounts"* bug — exactly the class of defect that duplicated,
 * ad-hoc bigint-and-decimals math tends to reintroduce. Consolidating the
 * conversions here gives every caller a single, unit-tested source of truth.
 *
 * Precision contract
 * ------------------
 * All arithmetic is performed in `BigInt`. The **only** place a value is
 * converted to `Number` is the final display-scaling step in
 * {@link toDecimalNumber}, and even there the integer and fractional parts are
 * split as strings first so large amounts do not lose precision before scaling.
 */

/** Basis-points denominator: 1 bp = 0.01 %, so 10 000 bp = 100 %. */
export const BPS_DENOMINATOR = 10_000n;

/** Protocol fee, expressed in basis points: 0.05 % = 5 bp. */
export const PROTOCOL_FEE_BPS = 5n;

/**
 * Fixed-point scale used when weighting a quote's destination amount by a
 * solver's performance variance (see {@link varianceScaleFromPerfScore}).
 */
export const VARIANCE_SCALE = 1_000n;

/**
 * Largest `decimals` value we accept. Well beyond any real token (18 is the
 * practical maximum) while still guarding against absurd input.
 */
const MAX_DECIMALS = 36;

/**
 * Validate that `decimals` is a non-negative integer within a sane range.
 *
 * @throws {RangeError} when `decimals` is not an integer in `[0, 36]`.
 */
export function assertValidDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `decimals must be an integer in [0, ${MAX_DECIMALS}], received ${decimals}`,
    );
  }
}

/**
 * Parse a non-negative integer base-unit amount into a `BigInt`.
 *
 * Accepts either a `BigInt` (returned as-is after a sign check) or a decimal
 * string of ASCII digits. Leading/trailing whitespace is tolerated.
 *
 * @throws {RangeError} when the value is not a non-negative integer.
 */
export function parseBaseUnits(value: string | bigint): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`base-unit amount must be non-negative, received ${value}`);
    }
    return value;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RangeError(`invalid base-unit amount: ${JSON.stringify(value)}`);
  }
  return BigInt(trimmed);
}

/**
 * Convert a base-unit integer amount to a human-scaled decimal `Number`.
 *
 * Equivalent to `Number(baseUnits) / 10 ** decimals` but precision-safe for
 * amounts above `Number.MAX_SAFE_INTEGER`: the whole and fractional parts are
 * assembled as a decimal string and parsed once, so the only rounding is the
 * unavoidable `string → Number` step.
 *
 * @param baseUnits Non-negative integer amount in the token's smallest unit.
 * @param decimals  Number of decimal places the token uses (e.g. `6` for USDC).
 */
export function toDecimalNumber(baseUnits: string | bigint, decimals: number): number {
  assertValidDecimals(decimals);
  const units = parseBaseUnits(baseUnits);
  if (decimals === 0) {
    return Number(units);
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = (units % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return Number(fraction ? `${whole}.${fraction}` : whole.toString());
}

/**
 * Convert a human-scaled decimal `Number` back to a base-unit integer string.
 *
 * The inverse of {@link toDecimalNumber}. Any precision in `amount` beyond
 * `decimals` places is truncated (not rounded), matching how on-chain token
 * transfers treat sub-unit dust.
 *
 * @throws {RangeError} when `amount` is negative or not finite.
 */
export function toBaseUnits(amount: number, decimals: number): string {
  assertValidDecimals(decimals);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`amount must be a non-negative finite number, received ${amount}`);
  }
  // `toFixed` expands any exponential notation and gives us a fixed-point string
  // with one extra digit, which we then truncate to `decimals` places.
  const fixed = amount.toFixed(decimals + 1);
  const [whole, fractionRaw = ""] = fixed.split(".");
  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, "0");
  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined).toString();
}

/**
 * Calculate the protocol fee for a destination amount.
 *
 * `fee = dstAmount * PROTOCOL_FEE_BPS / BPS_DENOMINATOR` (0.05 %), floored to
 * an integer number of base units via `BigInt` division.
 *
 * @param dstAmount Destination amount in base units.
 * @returns The fee in base units.
 */
export function calculateProtocolFee(dstAmount: string | bigint): bigint {
  return (parseBaseUnits(dstAmount) * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
}

/**
 * Derive the integer variance scale (out of {@link VARIANCE_SCALE}) applied to
 * a quote's destination amount, given a solver's `[0, 1]` performance score.
 *
 * A perfect score (`1`) yields no haircut (`VARIANCE_SCALE`); a zero score
 * yields the maximum 0.8 % haircut. `perfScore` is clamped to `[0, 1]`.
 */
export function varianceScaleFromPerfScore(perfScore: number): number {
  const clamped = Math.min(Math.max(perfScore, 0), 1);
  const variancePct = (1 - clamped) * 0.008;
  return Math.round(Number(VARIANCE_SCALE) * (1 - variancePct));
}

/**
 * Apply an integer variance scale (see {@link varianceScaleFromPerfScore}) to a
 * source amount, entirely in `BigInt`:
 * `dstAmount = srcAmount * varianceScale / VARIANCE_SCALE`.
 *
 * @param srcAmount     Source amount in base units.
 * @param varianceScale Integer scale, typically `0 … VARIANCE_SCALE`.
 */
export function applyVarianceScale(
  srcAmount: string | bigint,
  varianceScale: number,
): bigint {
  return (parseBaseUnits(srcAmount) * BigInt(varianceScale)) / VARIANCE_SCALE;
}
