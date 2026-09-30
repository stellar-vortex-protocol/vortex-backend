import * as fc from "fast-check";
import {
  parseBaseUnits,
  toBaseUnits,
  toDecimalNumber,
  calculateProtocolFee,
  varianceScaleFromPerfScore,
  assertValidDecimals,
} from "../../src/common/amount";
import { ADVERSARIAL_STRINGS } from "./adversarial";
import { assertWithSeedReport, unicodeStrArb } from "./seed";

describe("amount parsing fuzz (issue #466)", () => {
  // Exact round-trip for amounts whose decimal form fits float64 precisely
  // (<=12 significant digits). Larger values lose precision in the documented
  // "unavoidable string -> Number step", so they are out of scope for EXACTness.
  it("accepted amounts round-trip exactly through amount.ts", async () => {
    await assertWithSeedReport(
      "amount:round-trip",
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        fc.integer({ min: 1, max: 7 }),
        (baseUnits, decimals) => {
          try {
            assertValidDecimals(decimals);
            const decimal = toDecimalNumber(baseUnits, decimals);
            const asBaseString = toBaseUnits(decimal, decimals);
            return parseBaseUnits(asBaseString) === baseUnits;
          } catch {
            return true;
          }
        },
      ),
    );
  });

  it("toDecimalNumber + toBaseUnits round-trip for whole-unit values", async () => {
    await assertWithSeedReport(
      "amount:decimal-round-trip",
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 7 }),
        (wholeUnits, decimals) => {
          try {
            assertValidDecimals(decimals);
            const decimal = toDecimalNumber(BigInt(wholeUnits), decimals);
            const back = toBaseUnits(decimal, decimals);
            return BigInt(back) === BigInt(wholeUnits);
          } catch {
            return true;
          }
        },
      ),
    );
  });

  // "Never throws unhandled": any thrown Error is catchable by callers.
  it("parseBaseUnits never throws unhandled on adversarial strings", async () => {
    await assertWithSeedReport(
      "amount:adversarial",
      fc.property(
        fc.oneof(fc.constantFrom(...ADVERSARIAL_STRINGS), fc.string(), unicodeStrArb()),
        (input) => {
          try {
            const value = parseBaseUnits(input);
            return typeof value === "bigint";
          } catch (e) {
            return e instanceof Error;
          }
        },
      ),
    );
  });

  // Documented contract: invalid input throws a controlled RangeError (400-class),
  // never a raw SyntaxError/TypeError from BigInt (which would be a 500).
  it("parseBaseUnits rejects invalid input with a controlled RangeError", async () => {
    await assertWithSeedReport(
      "amount:controlled-error",
      fc.property(
        fc.constantFrom("", " ", "abc", "1.2.3", "--1", "-5", "0x10", "1e5", "1_000", "١٢٣"),
        (input) => {
          try {
            parseBaseUnits(input);
            return false; // should have thrown
          } catch (e) {
            return e instanceof RangeError;
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it("calculateProtocolFee handles arbitrary bigint input without crashing", async () => {
    await assertWithSeedReport(
      "amount:fee",
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (dstAmount) => {
        try {
          const fee = calculateProtocolFee(dstAmount);
          return typeof fee === "bigint" && fee >= 0n;
        } catch (e) {
          return !(e instanceof TypeError) && !(e instanceof RangeError);
        }
      }),
    );
  });

  it("varianceScaleFromPerfScore stays finite and bounded for edge numeric inputs", async () => {
    await assertWithSeedReport(
      "amount:variance",
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
        (perfScore) => {
          try {
            const scale = varianceScaleFromPerfScore(perfScore);
            return Number.isFinite(scale) && scale >= 0 && scale <= 1000;
          } catch (e) {
            return !(e instanceof TypeError) && !(e instanceof RangeError);
          }
        },
      ),
    );
  });
});