/**
 * Archive I/O for the simulation harness (issue #452).
 *
 * Input is JSON Lines: one archived intent event (or price snapshot) per
 * line. Rows in the public `intents` dataset schema replay directly; rows
 * without an explicit `event` field default to `"intent"`. `#` comment
 * lines and blank lines are ignored, which keeps fixtures hand-editable.
 */
import { createPrng } from "./prng";
import { PriceBook } from "./prices";
import type { PriceRow } from "./prices";
import type { ArchivedIntent, SimEvent } from "./types";

function parseJsonl(text: string, label: string): Array<{ lineNo: number; value: unknown }> {
  const out: Array<{ lineNo: number; value: unknown }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      out.push({ lineNo: i + 1, value: JSON.parse(line) });
    } catch (err) {
      throw new Error(`${label} line ${i + 1}: invalid JSON (${(err as Error).message})`);
    }
  }
  return out;
}

function requireNumber(row: Record<string, unknown>, key: string, lineNo: number, label: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} line ${lineNo}: "${key}" must be a finite number`);
  }
  return value;
}

function requireString(row: Record<string, unknown>, key: string, lineNo: number, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} line ${lineNo}: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Parse an archived intent stream (JSONL) into timestamped events.
 *
 * @param text Raw file contents.
 * @throws When a row is not valid JSON or lacks the required fields
 * (`intentId`, `createdAt`, `deadline`, `srcChain`, `srcAmount`, `minDstAmount`).
 * @returns Events sorted by timestamp (stable for equal timestamps).
 */
export function parseIntentEvents(text: string): SimEvent[] {
  const events: SimEvent[] = [];
  for (const { lineNo, value } of parseJsonl(text, "intents archive")) {
    const row = value as Record<string, unknown>;
    const intent: ArchivedIntent = {
      intentId: requireString(row, "intentId", lineNo, "intents archive"),
      createdAt: requireNumber(row, "createdAt", lineNo, "intents archive"),
      deadline: requireNumber(row, "deadline", lineNo, "intents archive"),
      srcChain: requireString(row, "srcChain", lineNo, "intents archive"),
      srcAmount: requireString(row, "srcAmount", lineNo, "intents archive"),
      minDstAmount: requireString(row, "minDstAmount", lineNo, "intents archive"),
      srcToken: typeof row.srcToken === "string" ? row.srcToken : undefined,
      srcTokenSymbol: typeof row.srcTokenSymbol === "string" ? row.srcTokenSymbol : undefined,
      dstToken: typeof row.dstToken === "string" ? row.dstToken : undefined,
      dstTokenSymbol: typeof row.dstTokenSymbol === "string" ? row.dstTokenSymbol : undefined,
      dstChain: typeof row.dstChain === "string" ? row.dstChain : undefined,
      state: typeof row.state === "string" ? row.state : undefined,
      usdValueAtCreate: typeof row.usdValueAtCreate === "number" ? row.usdValueAtCreate : undefined,
      auction: (row.auction as ArchivedIntent["auction"]) ?? undefined,
      event: row.event === "quote_request" ? "quote_request" : "intent",
    };
    events.push({ ts: intent.createdAt, intent });
  }
  return events.sort((a, b) => a.ts - b.ts);
}

/**
 * Parse archived price snapshots (JSONL) into a {@link PriceBook}.
 *
 * @throws When a row lacks `ts`/`chain`/`symbol`/`priceUsd`.
 */
export function parsePriceBook(text: string): PriceBook {
  const rows: PriceRow[] = [];
  for (const { lineNo, value } of parseJsonl(text, "prices archive")) {
    const row = value as Record<string, unknown>;
    rows.push({
      ts: requireNumber(row, "ts", lineNo, "prices archive"),
      chain: requireString(row, "chain", lineNo, "prices archive"),
      symbol: requireString(row, "symbol", lineNo, "prices archive"),
      priceUsd: requireNumber(row, "priceUsd", lineNo, "prices archive"),
      decimals: typeof row.decimals === "number" ? row.decimals : undefined,
    });
  }
  return new PriceBook(rows);
}

const SYNTHETIC_SRC_CHAINS = ["ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"];

/**
 * Generate a deterministic synthetic archive — used by benchmarks, the
 * determinism tests, and `cli.ts --generate` for smoke runs without data.
 *
 * The stream mixes zero-width bursts (several intents in the same second)
 * with one-second gaps, so equal-timestamp ordering and clock advancement
 * are both exercised.
 *
 * @param count Number of intents to generate.
 * @param seed  PRNG seed; identical inputs yield identical archives.
 * @returns Events already sorted by timestamp.
 */
export function generateSyntheticArchive(count: number, seed: number): SimEvent[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count must be a non-negative integer, got ${count}`);
  }
  const random = createPrng(seed);
  const events: SimEvent[] = new Array(count);
  let ts = 1_700_000_000;
  for (let i = 0; i < count; i += 1) {
    if (random() < 0.3) ts += 1; // ~70% of events share the previous second
    const intent: ArchivedIntent = {
      intentId: `syn-${i}`,
      createdAt: ts,
      deadline: ts + 60 + Math.floor(random() * 120),
      srcChain: SYNTHETIC_SRC_CHAINS[i % SYNTHETIC_SRC_CHAINS.length],
      srcToken: "0xsimulated-src",
      srcTokenSymbol: "TOK",
      srcAmount: "1000000000000000000",
      dstToken: "CSIMDST",
      dstTokenSymbol: "USDC",
      minDstAmount: String(1_000_000 + (i % 100) * 1_000),
      state: "open",
      event: "intent",
    };
    events[i] = { ts, intent };
  }
  return events;
}
