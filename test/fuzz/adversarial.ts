/**
 * Adversarial string corpus for fuzzing DTO validation, amount parsing and
 * address validation (issue #466).
 *
 * Every entry here is a value that has historically crashed or bypassed
 * financial-API validators: unicode digits, huge exponents, signed zeros,
 * prototype-pollution keys, control characters and malformed Stellar strkeys.
 * The corpus is consumed by the fast-check generators as `fc.constantFrom`
 * members so the shrinker can always reduce a failure back to one of these.
 */
export const ADVERSARIAL_STRINGS: readonly string[] = [
  // Numeric edge cases
  "1e18", "-0", "0", "-0.0", "+0", "1E+999", "1e-999", "Infinity", "-Infinity", "NaN",
  "0x10", "0o17", "0b101", "1_000", "1,000", " 1", "1 ", "1.000000000000000000000001",
  "999999999999999999999999999999999999999999",
  // Unicode digits and lookalikes
  "١٢٣", "۱۲۳", "१२३", "１２３", "¼", "−1", "－1",
  // Prototype pollution / constructor keys
  "__proto__", "constructor", "prototype", "__defineGetter__",
  // JSON body attacks
  '{"__proto__": {"polluted": true}}', '["__proto__"]', '{"constructor": {"prototype": {}}}',
  // Overlong / degenerate
  "9".repeat(400), "1" + "0".repeat(400), ".".repeat(50), "..", "-", "+",
  // Control / invisible characters
  "\u0000", "\u001f", "‮", "​", "﻿", "\t", "\n", "\r\n",
  // Injection-ish (must be rejected as data, never crash)
  "' OR '1'='1", '{"$gt": ""}', "\\u0000",
  // Stellar strkey edge cases
  "G" + "A".repeat(55), "G" + "A".repeat(56), "g" + "a".repeat(55),
  "C" + "A".repeat(55), "S" + "A".repeat(55), "", " ",
];

/** Keys used to probe prototype-pollution handling in object bodies. */
export const ADVERSARIAL_OBJECT_KEYS: readonly string[] = [
  "__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty",
];
