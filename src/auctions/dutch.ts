export interface DutchAuction {
  startDstAmount: string;
  decayStart: number;
  decayEnd: number;
  exclusiveSolver?: string;
  exclusivityEnd?: number;
  /** Decay shape; defaults to "linear" for backward compatibility. */
  curve?: "linear" | "exponential" | "stepped";
  /** Exponent for the exponential curve (default 2). Higher = faster initial drop. */
  decayExponent?: number;
  /** Number of discrete plateaus for the stepped curve (default 10). */
  steps?: number;
}

/** Integer exponentiation in bigint (no floating point). */
function powBigInt(base: bigint, exp: number): bigint {
  let result = 1n;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result *= b;
    b *= b;
    e >>= 1;
  }
  return result;
}

/** Return the deterministic integer price for a Dutch auction at `timestamp`. */
export function dutchAuctionPrice(auction: DutchAuction, timestamp: number, minDstAmount: string): string {
  const startAmount = BigInt(auction.startDstAmount);
  const minAmount = BigInt(minDstAmount);
  if (timestamp <= auction.decayStart) return startAmount.toString();
  if (timestamp >= auction.decayEnd) return minAmount.toString();

  const elapsed = BigInt(timestamp - auction.decayStart);
  const duration = BigInt(auction.decayEnd - auction.decayStart);
  const totalDrop = startAmount - minAmount;
  const curve = auction.curve ?? "linear";

  let priceDrop: bigint;
  switch (curve) {
    case "exponential": {
      const exponent = auction.decayExponent && auction.decayExponent > 0 ? Math.floor(auction.decayExponent) : 2;
      // Fraction of drop conceded = 1 - (1 - t)^exponent, front-loading concessions.
      const remaining = duration - elapsed;
      const remainingPow = powBigInt(remaining, exponent);
      const durationPow = powBigInt(duration, exponent);
      priceDrop = (totalDrop * (durationPow - remainingPow)) / durationPow;
      break;
    }
    case "stepped": {
      const steps = auction.steps && auction.steps > 0 ? Math.floor(auction.steps) : 10;
      const stepSize = duration / BigInt(steps);
      // Number of completed plateaus; clamp to [0, steps].
      const plateau = stepSize === 0n ? BigInt(steps) : elapsed / stepSize;
      const clamped = plateau > BigInt(steps) ? BigInt(steps) : plateau;
      priceDrop = (totalDrop * clamped) / BigInt(steps);
      break;
    }
    case "linear":
    default:
      priceDrop = (totalDrop * elapsed) / duration;
      break;
  }

  return (startAmount - priceDrop).toString();
}

/**
 * Compute the current live Dutch-auction price for an intent's stored auction
 * field at `timestamp`. Returns `null` when the intent has no auction (i.e. it
 * is not a Dutch-auction intent). Reuses `dutchAuctionPrice()` so the REST read
 * path and the WS ticker share identical decay math.
 */
export function currentAuctionPrice(
  auction: DutchAuction | null | undefined,
  timestamp: number,
  minDstAmount: string,
): string | null {
  if (!auction) return null;
  return dutchAuctionPrice(auction, timestamp, minDstAmount);
}
