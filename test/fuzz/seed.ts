import * as fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";
import { ADVERSARIAL_STRINGS, ADVERSARIAL_OBJECT_KEYS } from "./adversarial";

export function fuzzNumRuns(): number {
  const fromEnv = Number(process.env.FUZZ_NUM_RUNS ?? "0");
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 200;
}

export function resolveSeed(): number {
  const fromEnv = process.env.FUZZ_SEED;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return Math.floor(Math.random() * 0x7fffffff);
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    return (json ?? String(value)).slice(0, 2000);
  } catch {
    return String(value);
  }
}

/**
 * Append this run's seed as a single JSON line (JSONL) to fuzz-seed-report.json
 * (uploaded as a CI artifact). Append-only by design: there is no read-modify-
 * write, so there is no file-system race (CodeQL js/filesystem-race-condition)
 * and concurrent workers cannot clobber each other's entries.
 */
export function recordSeedRun(label: string, seed: number, numRuns: number): void {
  try {
    const file = path.resolve(process.cwd(), "fuzz-seed-report.json");
    const line = JSON.stringify({ label, seed, numRuns, at: new Date().toISOString() }) + "\n";
    fs.appendFileSync(file, line);
  } catch {
    // Reporting must never fail the suite.
  }
}

/**
 * fc.assert wrapper that pins an explicit seed, applies the bounded/nightly
 * iteration count, and on failure prints a copy-pasteable repro command with
 * the exact seed and minimal counterexample. Async so async properties settle.
 */
export async function assertWithSeedReport(
  label: string,
  property: fc.IPropertyWithHooks<unknown> | fc.IAsyncPropertyWithHooks<unknown>,
  params: fc.Parameters<unknown> = {},
): Promise<void> {
  const seed = resolveSeed();
  const numRuns = params.numRuns ?? fuzzNumRuns();
  recordSeedRun(label, seed, numRuns);
  try {
    await fc.assert(property as fc.IAsyncPropertyWithHooks<unknown>, { ...params, seed, numRuns });
  } catch (err) {
    const e = err as { counterexample?: unknown; seed?: number };
    process.stderr.write(
      `\n[fuzz] FAILURE in "${label}"\n` +
        `[fuzz] seed=${e.seed ?? seed} numRuns=${numRuns}\n` +
        `[fuzz] counterexample: ${safeStringify(e.counterexample)}\n` +
        `[fuzz] reproduce: FUZZ_SEED=${e.seed ?? seed} FUZZ_NUM_RUNS=${numRuns} ` +
        `npx jest --config jest.fuzz.config.js\n`,
    );
    throw err;
  }
}

/**
 * Version-safe unicode string arbitrary. `fc.unicodeString()` was removed in
 * fast-check v4, so we build one from code points (avoiding surrogate halves).
 */
export function unicodeStrArb(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0x20, max: 0xd7ff }), { maxLength: 48 })
    .map((codes) => String.fromCharCode(...codes));
}

/** JSON-shaped arbitrary mixing real JSON with adversarial strings/keys. */
export function adversarialJsonValue(): fc.Arbitrary<unknown> {
  const str = fc.oneof(
    fc.string(),
    unicodeStrArb(),
    fc.constantFrom(...ADVERSARIAL_STRINGS_LIST()),
  );
  const leaf = fc.oneof(
    str,
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.boolean(),
    fc.constant(null),
  );
  const obj = fc.dictionary(fc.oneof(fc.string(), fc.constantFrom(...ADVERSARIAL_KEYS_LIST())), leaf);
  const arr = fc.array(leaf);
  return fc.oneof(leaf, obj, arr, fc.json().map((s) => JSON.parse(s) as unknown));
}

function ADVERSARIAL_STRINGS_LIST(): string[] {
  return [...ADVERSARIAL_STRINGS];
}

function ADVERSARIAL_KEYS_LIST(): string[] {
  return [...ADVERSARIAL_OBJECT_KEYS];
}