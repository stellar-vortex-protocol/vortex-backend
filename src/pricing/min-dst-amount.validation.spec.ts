import {
  USD_PRICE_SCALE,
  computeFairDstAmount,
  sourceNotionalUsd,
  usdPriceToScale,
  validateMinDstAmount,
  type OracleMinDstConfig,
  type PriceSnapshot,
} from "./min-dst-amount.validation";

const CONFIG: OracleMinDstConfig = {
  maxUserSlippageBps: 100n,
  maxPremiumBps: 50n,
  failOpenMaxUsd: 100n * USD_PRICE_SCALE,
  maxStalenessMs: 60_000,
};

const FRESH: PriceSnapshot = {
  srcPriceUsd: USD_PRICE_SCALE, // $1
  dstPriceUsd: USD_PRICE_SCALE, // $1
  asOfMs: 1_000_000,
};

describe("usdPriceToScale", () => {
  it("encodes one dollar exactly", () => {
    expect(usdPriceToScale(1)).toBe(USD_PRICE_SCALE);
  });

  it("encodes fractional and large prices without float leftovers", () => {
    expect(usdPriceToScale(0.1182)).toBe(11_820_000n);
    expect(usdPriceToScale(3512.8)).toBe(351_280_000_000n);
  });

  it("returns null for non-positive prices", () => {
    expect(usdPriceToScale(0)).toBeNull();
    expect(usdPriceToScale(-1)).toBeNull();
    expect(usdPriceToScale(Number.NaN)).toBeNull();
  });
});

describe("computeFairDstAmount", () => {
  it.each([
    // srcAmt, srcDec, dstDec, srcPx, dstPx, expected fair
    { name: "6→7 same $1", src: 1_000_000n, sd: 6, dd: 7, expected: 10_000_000n },
    { name: "6→6 same $1", src: 1_000_000n, sd: 6, dd: 6, expected: 1_000_000n },
    { name: "18→6 same $1", src: 10n ** 18n, sd: 18, dd: 6, expected: 1_000_000n },
    { name: "7→18 same $1", src: 10n ** 7n, sd: 7, dd: 18, expected: 10n ** 18n },
  ])("$name", ({ src, sd, dd, expected }) => {
    expect(computeFairDstAmount(src, sd, dd, USD_PRICE_SCALE, USD_PRICE_SCALE)).toBe(expected);
  });
});

describe("validateMinDstAmount", () => {
  const base = {
    srcAmount: 1_000_000n,
    srcDecimals: 6,
    dstDecimals: 7,
    acknowledgeHighSlippage: false,
    nowMs: 1_000_000,
    snapshot: FRESH,
  };

  // fair = 10_000_000 dst units. 100 bps → min = 9_900_000.

  it("accepts the exact MAX_USER_SLIPPAGE_BPS boundary", () => {
    const result = validateMinDstAmount({ ...base, minDstAmount: 9_900_000n }, CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fairValue).toBe(10_000_000n);
      expect(result.slippageBps).toBe(100n);
      expect(result.premiumBps).toBe(0n);
    }
  });

  it("accepts just below maximum allowed slippage (99 bps)", () => {
    // 99 bps of 10_000_000 = 99_000 → min = 9_901_000
    const result = validateMinDstAmount({ ...base, minDstAmount: 9_901_000n }, CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slippageBps).toBe(99n);
  });

  it("rejects just above maximum allowed slippage (101 bps)", () => {
    // 101 bps → min = 9_899_000
    const result = validateMinDstAmount({ ...base, minDstAmount: 9_899_000n }, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXCESSIVE_SLIPPAGE");
      expect(result.fairValue).toBe(10_000_000n);
      expect(result.slippageBps).toBe(101n);
    }
  });

  it("accepts excessive slippage when acknowledgeHighSlippage is true", () => {
    const result = validateMinDstAmount(
      { ...base, minDstAmount: 5_000_000n, acknowledgeHighSlippage: true },
      CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slippageBps).toBe(5000n);
  });

  it("rejects excessive slippage when acknowledgement is absent/false", () => {
    const result = validateMinDstAmount(
      { ...base, minDstAmount: 5_000_000n, acknowledgeHighSlippage: false },
      CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EXCESSIVE_SLIPPAGE");
  });

  it("accepts the exact MAX_PREMIUM_BPS boundary", () => {
    // 50 bps of 10_000_000 = 50_000 → min = 10_050_000
    const result = validateMinDstAmount({ ...base, minDstAmount: 10_050_000n }, CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.premiumBps).toBe(50n);
      expect(result.slippageBps).toBe(0n);
    }
  });

  it("rejects just above MAX_PREMIUM_BPS", () => {
    // Integer bps floors: 10_050_001 still yields 50 bps. 51 bps starts at 10_051_000.
    const result = validateMinDstAmount({ ...base, minDstAmount: 10_051_000n }, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("EXCESSIVE_PREMIUM");
      expect(result.premiumBps).toBeGreaterThan(50n);
    }
  });

  it("rejects zero and invalid amounts", () => {
    expect(validateMinDstAmount({ ...base, srcAmount: 0n, minDstAmount: 9_900_000n }, CONFIG).ok).toBe(
      false,
    );
    expect(validateMinDstAmount({ ...base, minDstAmount: 0n }, CONFIG).ok).toBe(false);
    expect(validateMinDstAmount({ ...base, minDstAmount: "12.5" }, CONFIG).ok).toBe(false);
  });

  it("handles a very large src amount without precision loss", () => {
    const src = 10n ** 24n; // 1e24 at 18 decimals = 1e6 whole tokens
    const fair = computeFairDstAmount(src, 18, 6, USD_PRICE_SCALE, USD_PRICE_SCALE);
    expect(fair).toBe(1_000_000_000_000n);
    const min = (fair * 9900n) / 10_000n;
    const result = validateMinDstAmount(
      {
        ...base,
        srcAmount: src,
        srcDecimals: 18,
        dstDecimals: 6,
        minDstAmount: min,
      },
      CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fairValue).toBe(fair);
  });

  it("fail-opens when the oracle is missing dest price and notional is under the USD cap", () => {
    const result = validateMinDstAmount(
      {
        ...base,
        snapshot: { srcPriceUsd: USD_PRICE_SCALE, dstPriceUsd: null, asOfMs: 1_000_000 },
        minDstAmount: 1n,
      },
      CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.oracleUnavailable).toBe(true);
      expect(result.fairValue).toBeNull();
    }
  });

  it("fail-closes when the oracle is unavailable above the USD threshold", () => {
    const srcAmount = 200_000_000n; // $200 at 6 decimals
    expect(sourceNotionalUsd(srcAmount, 6, USD_PRICE_SCALE)).toBe(200n * USD_PRICE_SCALE);
    const result = validateMinDstAmount(
      {
        ...base,
        srcAmount,
        minDstAmount: 1n,
        snapshot: { srcPriceUsd: USD_PRICE_SCALE, dstPriceUsd: null, asOfMs: 1_000_000 },
      },
      CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ORACLE_UNAVAILABLE");
  });

  it("treats a stale snapshot as unavailable (fail-closed above threshold)", () => {
    const result = validateMinDstAmount(
      {
        ...base,
        srcAmount: 200_000_000n,
        minDstAmount: 1_980_000_000n,
        nowMs: 1_000_000 + 60_001,
        snapshot: FRESH,
      },
      CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("STALE_ORACLE");
  });

  it("fail-opens a stale snapshot when source notional is under the USD cap", () => {
    const result = validateMinDstAmount(
      {
        ...base,
        minDstAmount: 1n,
        nowMs: 1_000_000 + 60_001,
        snapshot: FRESH,
      },
      CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.oracleUnavailable).toBe(true);
  });

  it("fail-closes when the source price is missing (USD notional unknown)", () => {
    const result = validateMinDstAmount(
      {
        ...base,
        snapshot: { srcPriceUsd: null, dstPriceUsd: USD_PRICE_SCALE, asOfMs: 1_000_000 },
        minDstAmount: 9_900_000n,
      },
      CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ORACLE_UNAVAILABLE");
  });

  it("treats a non-positive snapshot price as unavailable", () => {
    const result = validateMinDstAmount(
      {
        ...base,
        srcAmount: 200_000_000n,
        snapshot: { srcPriceUsd: 0n, dstPriceUsd: USD_PRICE_SCALE, asOfMs: 1_000_000 },
        minDstAmount: 1n,
      },
      CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ORACLE_UNAVAILABLE");
  });

  it.each([
    { name: "6→7", src: 1_000_000n, sd: 6, dd: 7, min: 9_900_000n, fair: 10_000_000n },
    { name: "6→6", src: 1_000_000n, sd: 6, dd: 6, min: 990_000n, fair: 1_000_000n },
    { name: "18→6", src: 10n ** 18n, sd: 18, dd: 6, min: 990_000n, fair: 1_000_000n },
    { name: "7→18", src: 10n ** 7n, sd: 7, dd: 18, min: (10n ** 18n * 9900n) / 10_000n, fair: 10n ** 18n },
  ])("accepts the 100 bps boundary for $name decimals", ({ src, sd, dd, min, fair }) => {
    const result = validateMinDstAmount(
      { ...base, srcAmount: src, srcDecimals: sd, dstDecimals: dd, minDstAmount: min },
      CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fairValue).toBe(fair);
      expect(result.slippageBps).toBe(100n);
    }
  });
});
