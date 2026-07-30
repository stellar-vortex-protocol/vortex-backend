/**
 * Issue #46 — body size limit e2e test.
 *
 * Confirms that payloads exceeding 10 KB are rejected with HTTP 413
 * (Payload Too Large) before they reach any controller logic.
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("Body size limit (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /api/v1/intents rejects a payload > 10 KB with 413", async () => {
    // Build a body that is clearly over 10 KB by padding a string field
    const oversized = {
      user: "GE2ETESTUSER1234567",
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      srcTokenSymbol: "USDC",
      srcTokenDecimals: 6,
      // ~11 KB of noise in this field — validator never reached
      srcAmount: "1".padEnd(11 * 1024, "0"),
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      dstTokenSymbol: "USDC",
      dstTokenDecimals: 7,
      minDstAmount: "990000",
    };

    await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(oversized)
      .expect(413);
  });

  it("POST /api/v1/intents accepts a payload within the 10 KB limit", async () => {
    const normal = {
      user: "GE2ETESTUSER1234567",
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

    await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(normal)
      .expect(201);
  });
});
