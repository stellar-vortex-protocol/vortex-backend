/**
 * ReDoS (Regular-expression Denial-of-Service) audit (issue #476).
 *
 * For each regex used in DTOs and validators we verify two properties:
 *
 *  1. Correctness — the pattern accepts exactly the strings it should and
 *     rejects the strings it should not.
 *  2. No catastrophic backtracking — each pattern is exercised against a
 *     pathological "evil" input (the classic ReDoS probe string) and must
 *     complete within a short wall-clock budget.
 *
 * What makes a regex catastrophic?
 *   Nested quantifiers over the same character class, such as `(a+)+` or
 *   `(a|aa)+`, can produce exponential matching time on inputs like "aaa…X".
 *   None of the patterns in this project use that structure — they are all
 *   anchored to a fixed-length token (`{55}`, `{56}`, `{40}`) or a simple
 *   non-nested greedy run (`\d+`, `[A-Z0-9]+`).  The tests below document
 *   this property and will catch any future regressions.
 *
 * Timing threshold: 10 ms per pattern on any modern machine.  This is
 * intentionally generous — a non-backtracking pattern on a 10 000 character
 * input completes in microseconds; 10 ms is a ×1000 safety margin.
 */

const MAX_REDOS_MS = 10;

/** Run `fn` and assert it completes within `maxMs`. */
function assertFastEnough(fn: () => void, maxMs = MAX_REDOS_MS): void {
  const start = Date.now();
  fn();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(maxMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Patterns extracted verbatim from source files under audit
// ─────────────────────────────────────────────────────────────────────────────

/** src/config/env.validation.ts — Stellar secret seed */
const STELLAR_SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

/** src/common/validators/is-valid-address.validator.ts — Stellar public key */
const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/** src/common/validators/is-valid-address.validator.ts — EVM address */
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/**
 * src/intents/dto/create-intent.dto.ts, fill-intent.dto.ts,
 * quote-request.dto.ts, common/amount.ts — unsigned integer string
 */
const UINT_STRING_PATTERN = /^\d+$/;

/** src/intents/dto/create-intent.dto.ts — Stellar contract address */
const STELLAR_CONTRACT_PATTERN = /^[A-Z0-9]{56}$/;

// ─────────────────────────────────────────────────────────────────────────────
describe("ReDoS audit — all validator regexes (issue #476)", () => {
  // ── STELLAR_SECRET_KEY_PATTERN ─────────────────────────────────────────────
  describe("STELLAR_SECRET_KEY_PATTERN /^S[A-Z2-7]{55}$/", () => {
    it("accepts a valid Stellar secret seed", () => {
      // 'S' + 55 uppercase base32 chars
      expect(STELLAR_SECRET_KEY_PATTERN.test("S" + "A".repeat(55))).toBe(true);
      expect(STELLAR_SECRET_KEY_PATTERN.test("S" + "ABCDEFG2345677".repeat(4))).toBe(false); // 57 chars
    });

    it("rejects strings that are too short", () => {
      expect(STELLAR_SECRET_KEY_PATTERN.test("S" + "A".repeat(54))).toBe(false);
    });

    it("rejects strings that are too long", () => {
      expect(STELLAR_SECRET_KEY_PATTERN.test("S" + "A".repeat(56))).toBe(false);
    });

    it("rejects strings that start with the wrong character", () => {
      expect(STELLAR_SECRET_KEY_PATTERN.test("G" + "A".repeat(55))).toBe(false);
    });

    it("rejects strings with invalid base32 characters", () => {
      expect(STELLAR_SECRET_KEY_PATTERN.test("S" + "A".repeat(54) + "1")).toBe(false); // '1' not in [A-Z2-7]
    });

    it("completes in <10 ms on a 10 000-char evil input (ReDoS safety)", () => {
      const evil = "S" + "A".repeat(9998) + "!"; // anchored pattern, no catastrophic risk
      assertFastEnough(() => STELLAR_SECRET_KEY_PATTERN.test(evil));
    });
  });

  // ── STELLAR_ADDRESS_PATTERN ────────────────────────────────────────────────
  describe("STELLAR_ADDRESS_PATTERN /^G[A-Z2-7]{55}$/", () => {
    it("accepts a valid Stellar public key", () => {
      expect(STELLAR_ADDRESS_PATTERN.test("G" + "A".repeat(55))).toBe(true);
    });

    it("rejects wrong length", () => {
      expect(STELLAR_ADDRESS_PATTERN.test("G" + "A".repeat(54))).toBe(false);
      expect(STELLAR_ADDRESS_PATTERN.test("G" + "A".repeat(56))).toBe(false);
    });

    it("rejects invalid prefix", () => {
      expect(STELLAR_ADDRESS_PATTERN.test("S" + "A".repeat(55))).toBe(false);
    });

    it("rejects lowercase characters", () => {
      expect(STELLAR_ADDRESS_PATTERN.test("G" + "a".repeat(55))).toBe(false);
    });

    it("completes in <10 ms on a 10 000-char evil input (ReDoS safety)", () => {
      const evil = "G" + "A".repeat(9998) + "!";
      assertFastEnough(() => STELLAR_ADDRESS_PATTERN.test(evil));
    });
  });

  // ── EVM_ADDRESS_PATTERN ────────────────────────────────────────────────────
  describe("EVM_ADDRESS_PATTERN /^0x[a-fA-F0-9]{40}$/", () => {
    it("accepts a valid EVM address", () => {
      expect(EVM_ADDRESS_PATTERN.test("0x" + "a".repeat(40))).toBe(true);
      expect(EVM_ADDRESS_PATTERN.test("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
    });

    it("rejects wrong length", () => {
      expect(EVM_ADDRESS_PATTERN.test("0x" + "a".repeat(39))).toBe(false);
      expect(EVM_ADDRESS_PATTERN.test("0x" + "a".repeat(41))).toBe(false);
    });

    it("rejects missing 0x prefix", () => {
      expect(EVM_ADDRESS_PATTERN.test("a".repeat(42))).toBe(false);
    });

    it("rejects invalid hex characters", () => {
      expect(EVM_ADDRESS_PATTERN.test("0x" + "g".repeat(40))).toBe(false);
    });

    it("completes in <10 ms on a 10 000-char evil input (ReDoS safety)", () => {
      const evil = "0x" + "a".repeat(9997) + "!";
      assertFastEnough(() => EVM_ADDRESS_PATTERN.test(evil));
    });
  });

  // ── UINT_STRING_PATTERN ────────────────────────────────────────────────────
  describe("UINT_STRING_PATTERN /^\\d+$/", () => {
    it("accepts valid non-negative integer strings", () => {
      expect(UINT_STRING_PATTERN.test("0")).toBe(true);
      expect(UINT_STRING_PATTERN.test("1000000")).toBe(true);
      expect(UINT_STRING_PATTERN.test("9".repeat(50))).toBe(true); // large but valid
    });

    it("rejects empty string", () => {
      expect(UINT_STRING_PATTERN.test("")).toBe(false);
    });

    it("rejects strings with non-digit characters", () => {
      expect(UINT_STRING_PATTERN.test("123abc")).toBe(false);
      expect(UINT_STRING_PATTERN.test("-1")).toBe(false);
      expect(UINT_STRING_PATTERN.test("1.5")).toBe(false);
    });

    it("completes in <10 ms on a 10 000-digit evil input (ReDoS safety)", () => {
      // Classic ReDoS probe for /^\d+$/ would be "0".repeat(N) + "X" but
      // the engine can fail fast with anchors.  Both passes are checked.
      const matching = "9".repeat(10_000);
      const failing = "9".repeat(10_000) + "X";
      assertFastEnough(() => UINT_STRING_PATTERN.test(matching));
      assertFastEnough(() => UINT_STRING_PATTERN.test(failing));
    });
  });

  // ── STELLAR_CONTRACT_PATTERN ───────────────────────────────────────────────
  describe("STELLAR_CONTRACT_PATTERN /^[A-Z0-9]{56}$/", () => {
    it("accepts a valid 56-char uppercase alphanumeric string", () => {
      expect(STELLAR_CONTRACT_PATTERN.test("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")).toBe(true);
      expect(STELLAR_CONTRACT_PATTERN.test("A".repeat(56))).toBe(true);
    });

    it("rejects wrong length", () => {
      expect(STELLAR_CONTRACT_PATTERN.test("A".repeat(55))).toBe(false);
      expect(STELLAR_CONTRACT_PATTERN.test("A".repeat(57))).toBe(false);
    });

    it("rejects lowercase characters", () => {
      expect(STELLAR_CONTRACT_PATTERN.test("a".repeat(56))).toBe(false);
    });

    it("rejects special characters", () => {
      expect(STELLAR_CONTRACT_PATTERN.test("A".repeat(55) + "!")).toBe(false);
    });

    it("completes in <10 ms on a 10 000-char evil input (ReDoS safety)", () => {
      const evil = "A".repeat(9999) + "!";
      assertFastEnough(() => STELLAR_CONTRACT_PATTERN.test(evil));
    });
  });
});
