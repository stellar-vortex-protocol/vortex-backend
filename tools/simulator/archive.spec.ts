/**
 * Data-layer tests for the simulation harness (issue #452): archive
 * parsing, the synthetic generator, price lookups, and the seeded PRNG.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSyntheticArchive, parseIntentEvents, parsePriceBook } from "./archive";
import { createPrng } from "./prng";
import { PriceBook } from "./prices";

const FIXTURE_DIR = join(__dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("parseIntentEvents (issue #452)", () => {
  it("parses the sample fixture, preserving order and dispatch kinds", () => {
    const events = parseIntentEvents(fixture("sample-intents.jsonl"));
    expect(events).toHaveLength(6);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    }
    expect(events[0].intent.intentId).toBe("sample-1");
    expect(events[5].intent.event).toBe("quote_request");
    expect(events[2].intent.auction?.decayEnd).toBe(1759248360);
    expect(events[1].intent.usdValueAtCreate).toBe(1000);
  });

  it("ignores blank lines and # comments", () => {
    const events = parseIntentEvents('# header\n\n{"intentId":"a","createdAt":10,"deadline":20,"srcChain":"base","srcAmount":"1","minDstAmount":"1"}\n');
    expect(events).toHaveLength(1);
  });

  it("reports the offending line for invalid JSON", () => {
    expect(() => parseIntentEvents('{"intentId":"a"}\n{oops\n')).toThrow(/line 2: invalid JSON/);
  });

  it("reports the missing field for incomplete rows", () => {
    expect(() => parseIntentEvents('{"intentId":"a","deadline":20}\n')).toThrow(/line 1: "createdAt" must be a finite number/);
  });
});

describe("generateSyntheticArchive (issue #452)", () => {
  it("is deterministic for a given seed and sorted by time", () => {
    const a = generateSyntheticArchive(500, 7);
    const b = generateSyntheticArchive(500, 7);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (let i = 1; i < a.length; i += 1) {
      expect(a[i].ts).toBeGreaterThanOrEqual(a[i - 1].ts);
    }
    expect(a[0].intent.intentId).toBe("syn-0");
    expect(a[499].intent.intentId).toBe("syn-499");
  });

  it("rejects negative counts", () => {
    expect(() => generateSyntheticArchive(-1, 0)).toThrow(/non-negative integer/);
  });
});

describe("PriceBook (issue #452)", () => {
  const book = new PriceBook([
    { ts: 100, chain: "ethereum", symbol: "USDC", priceUsd: 1, decimals: 6 },
    { ts: 200, chain: "ethereum", symbol: "USDC", priceUsd: 1.5, decimals: 6 },
    { ts: 50, chain: "stellar", symbol: "USDC", priceUsd: 1 },
  ]);

  it("returns the latest snapshot at or before the requested time", () => {
    expect(book.lookup("ethereum", "USDC", 99)).toBeNull();
    expect(book.lookup("ethereum", "USDC", 100)).toEqual({ priceUsd: 1, decimals: 6 });
    expect(book.lookup("ethereum", "USDC", 199)).toEqual({ priceUsd: 1, decimals: 6 });
    expect(book.lookup("ethereum", "USDC", 1_000)).toEqual({ priceUsd: 1.5, decimals: 6 });
  });

  it("returns null for unknown pairs", () => {
    expect(book.lookup("ethereum", "WETH", 500)).toBeNull();
    expect(new PriceBook().lookup("ethereum", "USDC", 500)).toBeNull();
  });

  it("converts base units with per-chain default decimals", () => {
    // ethereum row has explicit decimals: 6 → 2_500_000_000 = 2500.
    expect(book.usdValue("ethereum", "USDC", "2500000000", 150)).toBe(2500);
    // stellar row has no decimals → default 7 → 100000000 = 10.
    expect(book.usdValue("stellar", "USDC", "100000000", 60)).toBe(10);
    // Non-numeric amounts are unknown, never zero.
    expect(book.usdValue("stellar", "USDC", "not-a-number", 60)).toBeNull();
  });
});

describe("parsePriceBook (issue #452)", () => {
  it("builds a working book from JSONL", () => {
    const book = parsePriceBook(fixture("sample-prices.jsonl"));
    expect(book.lookup("stellar", "USDC", 1759248000)).toEqual({ priceUsd: 1, decimals: 7 });
    expect(book.lookup("base", "USDC", 1759248000)).toEqual({ priceUsd: 1, decimals: 6 });
  });

  it("validates required fields", () => {
    expect(() => parsePriceBook('{"ts":1,"chain":"ethereum"}\n')).toThrow(/"symbol" must be a non-empty string/);
  });
});

describe("createPrng (issue #452)", () => {
  it("reproduces the same sequence for the same seed", () => {
    const a = createPrng(123);
    const b = createPrng(123);
    const seqA = Array.from({ length: 32 }, () => a());
    const seqB = Array.from({ length: 32 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("stays in [0, 1)", () => {
    const random = createPrng(9);
    for (let i = 0; i < 1_000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
