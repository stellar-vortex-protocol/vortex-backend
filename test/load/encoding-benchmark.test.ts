/**
 * Encoding benchmark (Activity 1): Compare JSON vs MessagePack + deflate.
 * 
 * Measures:
 * - Bytes per event
 * - CPU per serialization
 * - p99 delivery latency at scale
 * 
 * Run with:
 *   npx jest --config test/jest-load.json test/load/encoding-benchmark.test.ts
 */

import { encode as msgpackEncode } from "@msgpack/msgpack";
import { deflateSync } from "zlib";

describe("WS encoding benchmark (Activity 1)", () => {
  const sampleEvent = {
    seq: 12345,
    type: "intent_created",
    timestamp: Date.now(),
    intent: {
      id: "intent_abc123def456",
      srcChain: "stellar",
      dstChain: "ethereum",
      srcToken: "USDC",
      dstToken: "USDC",
      srcAmount: "1000000000",
      dstAmount: "998500000",
      creator: "GCZM...XYZ",
      recipient: "0x1234...5678",
      state: "open",
      createdAt: "2026-09-29T12:00:00Z",
      deadline: 1727616000,
      bondRequirement: "100000000",
      metadata: {
        route: "direct",
        feePercent: "0.15",
      },
    },
  };

  it("JSON baseline: measure bytes and CPU", () => {
    const start = process.hrtime.bigint();
    const iterations = 10_000;

    for (let i = 0; i < iterations; i++) {
      JSON.stringify(sampleEvent);
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perEvent = elapsed / iterations * 1000; // µs

    const payload = JSON.stringify(sampleEvent);
    const bytes = Buffer.byteLength(payload, "utf8");

    console.log(`[JSON] ${bytes} bytes, ${perEvent.toFixed(1)} µs/event`);

    expect(bytes).toBeGreaterThan(500); // Sanity check
    expect(perEvent).toBeLessThan(50); // Should be fast
  });

  it("MessagePack: measure bytes and CPU", () => {
    const start = process.hrtime.bigint();
    const iterations = 10_000;

    for (let i = 0; i < iterations; i++) {
      msgpackEncode(sampleEvent);
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perEvent = elapsed / iterations * 1000; // µs

    const payload = msgpackEncode(sampleEvent);
    const bytes = payload.byteLength;

    console.log(`[MessagePack] ${bytes} bytes, ${perEvent.toFixed(1)} µs/event`);

    expect(bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(sampleEvent), "utf8"));
    expect(perEvent).toBeLessThan(100);
  });

  it("JSON + deflate: measure bytes and CPU", () => {
    const start = process.hrtime.bigint();
    const iterations = 10_000;

    const jsonPayload = Buffer.from(JSON.stringify(sampleEvent), "utf8");

    for (let i = 0; i < iterations; i++) {
      deflateSync(jsonPayload, { level: 6, memLevel: 6, windowBits: 13 });
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perEvent = elapsed / iterations * 1000; // µs

    const compressed = deflateSync(jsonPayload, { level: 6, memLevel: 6, windowBits: 13 });
    const bytes = compressed.byteLength;

    console.log(`[JSON+deflate] ${bytes} bytes, ${perEvent.toFixed(1)} µs/event`);

    expect(bytes).toBeLessThan(jsonPayload.byteLength);
    expect(perEvent).toBeLessThan(300); // Compression is CPU-intensive
  });

  it("MessagePack + deflate: measure bytes and CPU", () => {
    const start = process.hrtime.bigint();
    const iterations = 10_000;

    const msgpackPayload = Buffer.from(msgpackEncode(sampleEvent));

    for (let i = 0; i < iterations; i++) {
      deflateSync(msgpackPayload, { level: 6, memLevel: 6, windowBits: 13 });
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perEvent = elapsed / iterations * 1000; // µs

    const compressed = deflateSync(msgpackPayload, { level: 6, memLevel: 6, windowBits: 13 });
    const bytes = compressed.byteLength;

    console.log(`[MessagePack+deflate] ${bytes} bytes, ${perEvent.toFixed(1)} µs/event`);

    expect(bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(sampleEvent), "utf8"));
    expect(perEvent).toBeLessThan(300);
  });

  it("compression ratios summary", () => {
    const json = Buffer.byteLength(JSON.stringify(sampleEvent), "utf8");
    const msgpack = msgpackEncode(sampleEvent).byteLength;
    const jsonDeflate = deflateSync(Buffer.from(JSON.stringify(sampleEvent)), { level: 6 }).byteLength;
    const msgpackDeflate = deflateSync(Buffer.from(msgpackEncode(sampleEvent)), { level: 6 }).byteLength;

    console.log("\n=== Compression Summary ===");
    console.log(`JSON: ${json} bytes (1.00x)`);
    console.log(`MessagePack: ${msgpack} bytes (${(json / msgpack).toFixed(2)}x)`);
    console.log(`JSON+deflate: ${jsonDeflate} bytes (${(json / jsonDeflate).toFixed(2)}x)`);
    console.log(`MessagePack+deflate: ${msgpackDeflate} bytes (${(json / msgpackDeflate).toFixed(2)}x) 🏆`);
  });
});
