import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "../utils/create-test-app";

/**
 * Issue #404 — POST /intents must keep p95 < 50 ms on every INTENTS_STORE,
 * including the Postgres-backed ones (CI runs this with INTENTS_STORE=postgres).
 * Requests are sequential so the figure is per-request latency, not queueing.
 * WARMUP + SAMPLES stays under the global 100 req/min IP throttle.
 */
const SAMPLES = 80;
const WARMUP = 10;
const P95_BUDGET_MS = 50;

describe("POST /api/v1/intents latency", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, "127.0.0.1");
    baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  it(`keeps p95 under ${P95_BUDGET_MS} ms with idempotency keys`, async () => {
    const durations: number[] = [];
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      // A fresh user per request keeps the per-user throttle out of the picture.
      const body = {
        user: Keypair.random().publicKey(),
        srcChain: "ethereum",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        srcTokenSymbol: "USDC",
        srcTokenDecimals: 6,
        srcAmount: "1000000",
        dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        dstTokenSymbol: "USDC",
        dstTokenDecimals: 7,
        minDstAmount: "990000",
        idempotencyKey: `latency-${Date.now()}-${i}`,
      };
      const start = process.hrtime.bigint();
      await request(baseUrl).post("/api/v1/intents").send(body).expect(201);
      if (i >= WARMUP) durations.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(SAMPLES * 0.5)];
    const p95 = durations[Math.floor(SAMPLES * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`POST /intents store=${process.env.INTENTS_STORE ?? "memory"} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 60_000);
});
