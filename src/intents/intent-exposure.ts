import { ServiceUnavailableException } from "@nestjs/common";
import { Intent } from "./intents.types";

/** Price snapshots older than this are not safe for collateral decisions. */
export const MAX_EXPOSURE_PRICE_AGE_SECONDS = 300;
const USD_SCALE = 1_000_000n;

/** Convert a decimal USD price to six-decimal fixed point. */
function priceToMicros(priceUsd: number): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new ServiceUnavailableException({
      code: "STALE_PRICE",
      error: "A valid USD price is unavailable for exposure calculation",
      message: "A valid USD price is unavailable for exposure calculation",
    });
  }
  return BigInt(Math.round(priceUsd * Number(USD_SCALE)));
}

/** Convert arbitrary token base units to micro-USD using fixed-point math. */
export function baseUnitsToUsdMicros(amount: bigint, decimals: number, priceUsd: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || amount < 0n) {
    throw new ServiceUnavailableException({
      code: "INVALID_EXPOSURE_AMOUNT",
      error: "Amount cannot be valued safely",
      message: "Amount cannot be valued safely",
    });
  }
  return (amount * priceToMicros(priceUsd)) / (10n ** BigInt(decimals));
}

/**
 * Value an intent's source-token amount in micro-USD using its price snapshot.
 * `createdAt` bounds snapshot age conservatively because token snapshots do
 * not currently carry an independent oracle timestamp.
 */
export function intentExposureUsdMicros(intent: Intent, nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  const token = intent.srcToken;
  if (
    !token ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    nowSeconds - intent.createdAt > MAX_EXPOSURE_PRICE_AGE_SECONDS ||
    intent.createdAt > nowSeconds
  ) {
    throw new ServiceUnavailableException({
      code: "STALE_PRICE",
      error: "A fresh USD price is unavailable for this intent",
      message: "A fresh USD price is unavailable for this intent",
    });
  }

  let amount: bigint;
  try {
    amount = BigInt(intent.srcAmount);
  } catch {
    throw new ServiceUnavailableException({
      code: "INVALID_EXPOSURE_AMOUNT",
      error: "Intent amount cannot be valued safely",
      message: "Intent amount cannot be valued safely",
    });
  }
  if (amount < 0n) {
    throw new ServiceUnavailableException({
      code: "INVALID_EXPOSURE_AMOUNT",
      error: "Intent amount cannot be valued safely",
      message: "Intent amount cannot be valued safely",
    });
  }

  return baseUnitsToUsdMicros(amount, token.decimals, token.priceUSD ?? 0);
}