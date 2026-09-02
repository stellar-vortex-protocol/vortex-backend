import {
  BPS_DENOMINATOR,
  PROTOCOL_FEE_BPS,
  VARIANCE_SCALE,
  assertValidDecimals,
  applyVarianceScale,
  calculateProtocolFee,
  parseBaseUnits,
  toBaseUnits,
  toDecimalNumber,
  varianceScaleFromPerfScore,
} from "./amount";

describe("common/amount", () => {
  describe("constants", () => {
    it("encodes the documented 0.05% protocol fee", () => {
      expect(PROTOCOL_FEE_BPS).toBe(5n);
      expect(BPS_DENOMINATOR).toBe(10_000n);
      expect(VARIANCE_SCALE).toBe(1_000n);
    });
  });

  describe("assertValidDecimals", () => {
    it.each([0, 6, 7, 18, 36])("accepts %s", (d) => {
      expect(() => assertValidDecimals(d)).not.toThrow();
    });

    it.each([-1, 1.5, 37, NaN, Infinity])("rejects %s", (d) => {
      expect(() => assertValidDecimals(d)).toThrow(RangeError);
    });
  });

  describe("parseBaseUnits", () => {
    it("passes through a non-negative bigint", () => {
      expect(parseBaseUnits(42n)).toBe(42n);
    });

    it("parses a digit string, tolerating surrounding whitespace", () => {
      expect(parseBaseUnits("  1000000  ")).toBe(1_000_000n);
    });

    it("parses amounts far beyond Number.MAX_SAFE_INTEGER without loss", () => {
      const huge = "123456789012345678901234567890";
      expect(parseBaseUnits(huge)).toBe(BigInt(huge));
    });

    it.each(["-1", "1.5", "0x10", "", "abc", "1e3"])("rejects %j", (v) => {
      expect(() => parseBaseUnits(v)).toThrow(RangeError);
    });

    it("rejects a negative bigint", () => {
      expect(() => parseBaseUnits(-1n)).toThrow(RangeError);
    });
  });

  describe("toDecimalNumber", () => {
    it("scales by the given decimals", () => {
      expect(toDecimalNumber("1000000", 6)).toBe(1);
      expect(toDecimalNumber("1500000", 6)).toBe(1.5);
      expect(toDecimalNumber("1", 7)).toBe(0.0000001);
    });

    it("handles zero decimals as an identity", () => {
      expect(toDecimalNumber("123", 0)).toBe(123);
    });

    it("handles a zero amount for any decimals", () => {
      for (let d = 0; d <= 18; d++) {
        expect(toDecimalNumber("0", d)).toBe(0);
      }
    });

    it("accepts a bigint input", () => {
      expect(toDecimalNumber(2_500_000n, 6)).toBe(2.5);
    });

    it("stays precise for very large amounts where Number division would drift", () => {
      // 10^30 base units at 18 decimals = 10^12 whole units, exactly representable.
      const baseUnits = "1" + "0".repeat(30);
      expect(toDecimalNumber(baseUnits, 18)).toBe(1e12);
    });

    it("is the inverse of toBaseUnits for representable values", () => {
      for (const [amount, decimals] of [
        [1, 6],
        [1234.56, 2],
        [0.0000001, 7],
        [999999.999999, 6],
      ] as const) {
        expect(toDecimalNumber(toBaseUnits(amount, decimals), decimals)).toBeCloseTo(amount, decimals);
      }
    });

    it("rejects invalid decimals", () => {
      expect(() => toDecimalNumber("1", -1)).toThrow(RangeError);
    });
  });

  describe("toBaseUnits", () => {
    it("scales up by the given decimals", () => {
      expect(toBaseUnits(1, 6)).toBe("1000000");
      expect(toBaseUnits(1.5, 6)).toBe("1500000");
      expect(toBaseUnits(0, 18)).toBe("0");
    });

    it("truncates sub-unit precision rather than rounding", () => {
      expect(toBaseUnits(1.2345678, 6)).toBe("1234567");
    });

    it("rejects negative or non-finite amounts", () => {
      expect(() => toBaseUnits(-1, 6)).toThrow(RangeError);
      expect(() => toBaseUnits(Infinity, 6)).toThrow(RangeError);
    });
  });

  describe("calculateProtocolFee", () => {
    it("takes 0.05% of the destination amount, floored", () => {
      expect(calculateProtocolFee("1000000")).toBe(500n); // 0.05% of 1_000_000
      expect(calculateProtocolFee(0n)).toBe(0n);
      expect(calculateProtocolFee("19999")).toBe(9n); // 9.9995 -> 9
    });

    it("matches the inline formula for a large bigint amount", () => {
      const dst = 987654321987654321987654321n;
      expect(calculateProtocolFee(dst)).toBe((dst * 5n) / 10_000n);
    });
  });

  describe("varianceScaleFromPerfScore", () => {
    it("applies no haircut for a perfect score", () => {
      expect(varianceScaleFromPerfScore(1)).toBe(1000);
    });

    it("applies the maximum 0.8% haircut for a zero score", () => {
      expect(varianceScaleFromPerfScore(0)).toBe(992);
    });

    it("clamps out-of-range scores", () => {
      expect(varianceScaleFromPerfScore(5)).toBe(1000);
      expect(varianceScaleFromPerfScore(-5)).toBe(992);
    });

    it("reproduces the original inline computation", () => {
      for (const perfScore of [0.1, 0.25, 0.5, 0.73, 0.9]) {
        const expected = Math.round(1000 * (1 - (1 - perfScore) * 0.008));
        expect(varianceScaleFromPerfScore(perfScore)).toBe(expected);
      }
    });
  });

  describe("applyVarianceScale", () => {
    it("scales the source amount by scale / VARIANCE_SCALE in bigint", () => {
      expect(applyVarianceScale("1000000", 1000)).toBe(1_000_000n);
      expect(applyVarianceScale("1000000", 992)).toBe(992_000n);
    });

    it("matches the inline formula for a large bigint amount", () => {
      const src = 123456789012345678901234567890n;
      expect(applyVarianceScale(src, 997)).toBe((src * 997n) / 1000n);
    });
  });
});
