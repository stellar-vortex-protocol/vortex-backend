import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createTestApp } from "../utils/create-test-app";

/**
 * Issue #274 — concurrent-retry load test for the idempotency-key path in
 * IntentsService.create().
 *
 * Mirrors test/load/concurrent-accept.test.ts: fire N simultaneous POST
 * /api/v1/intents requests that all carry the *same* idempotencyKey and assert
 * that exactly one intent is created and every response points at it.
 */

const validCreateBody = {
  user: "GRACETESTUSER1234567",
  srcChain: "ethereum",
  srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "1000000",
  dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 7,
  minDstAmount: "990000",
};

describe("Concurrent idempotent create race load test", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates exactly one intent when N concurrent create() calls share an idempotencyKey", async () => {
    const idempotencyKey = randomUUID();
    const concurrency = 25;

    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        request(app.getHttpServer())
          .post("/api/v1/intents")
          .send({ ...validCreateBody, idempotencyKey }),
      ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<request.Response> => r.status === "fulfilled",
    );
    const created = fulfilled.filter((r) => r.value.status === 201);

    // Every accepted response must describe the same single intent.
    const intentIds = new Set(created.map((r) => r.value.body.intentId));
    expect(intentIds.size).toBe(1);

    const [intentId] = [...intentIds];
    const listed = (
      await request(app.getHttpServer()).get("/api/v1/intents").expect(200)
    ).body.intents as Array<{ intentId: string }>;
    const matches = listed.filter((i) => i.intentId === intentId);
    expect(matches).toHaveLength(1);
  });

  it("still creates distinct intents for concurrent calls with different keys", async () => {
    const concurrency = 10;

    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        request(app.getHttpServer())
          .post("/api/v1/intents")
          .send({ ...validCreateBody, idempotencyKey: randomUUID() })
          .expect(201),
      ),
    );

    const intentIds = new Set(results.map((r) => r.body.intentId));
    expect(intentIds.size).toBe(concurrency);
  });
});
