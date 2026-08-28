import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { IntentsService } from "../src/intents/intents.service";
import {
  verifyStellarSignature as _verify,
  buildCancelMessage,
  buildFillMessage,
} from "../src/common/stellar-signature";

// ── Test keypairs ──────────────────────────────────────────────────────────
// These are deterministic testnet keys used only in tests — never funded with
// real value.  ALPHA / BETA match the seeded solver addresses.
const USER_KP = Keypair.fromSecret("SCZANGBA5RLPPI7MHANPWXKX5XJKHEQF6TGOS7SXLKTD2KO3NDTW5VN");
const ALPHA_KP = Keypair.fromSecret("SBEEB2ZY2D25GRU4TXUARHHPQ2ASDRVQJZXWBUMW27VBVT3FCU2MEU5Q");
const BETA_KP = Keypair.fromSecret("SDIVQO7JBFG3XWMQ3VJXZ4CHDWWSBYNZIYXS3GVJNKJZXQZXQZXQZXQ");

function sign(kp: Keypair, message: string): string {
  const msgBuf = Buffer.from(message, "utf-8");
  return kp.sign(msgBuf).toString("base64");
}

function buildAcceptMessage(intentId: string, solver: string): string {
  return `accept:${intentId}:${solver}`;
}

const validCreateBody = {
  user: USER_KP.publicKey(),
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

describe("IntentsController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createIntent(overrides: Partial<typeof validCreateBody> = {}) {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...validCreateBody, ...overrides })
      .expect(201);
    return res.body as { intentId: string; state: string };
  }

  it("GET /api/v1/intents returns the seeded intents with pagination metadata", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/intents")
      .query({ limit: 2 })
      .expect(200);
    expect(res.body.intents).toHaveLength(2);
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    expect(res.body.limit).toBe(2);
  });

  it("GET /api/v1/intents with non-numeric limit returns 400", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/intents")
      .query({ limit: "abc" })
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("GET /api/v1/intents with non-numeric offset returns 400", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/intents")
      .query({ offset: "xyz" })
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("GET /api/v1/intents with limit > 100 returns 400", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/intents")
      .query({ limit: 500 })
      .expect(400);
    expect(res.body.error).toBe("Limit exceeds maximum allowed value of 100");
  });

  it("GET /api/v1/intents/open returns only open intents", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/intents/open").expect(200);
    expect(res.body.intents.every((i: { state: string }) => i.state === "open")).toBe(true);
  });

  it("GET /api/v1/intents/:id 404s for an unknown id", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/intents/does-not-exist").expect(404);
    expect(res.body).toEqual({ error: "Intent not found" });
  });

  it("POST /api/v1/intents with an invalid body returns detailed validation errors", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ user: "short" })
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("full lifecycle: create -> accept -> fill", async () => {
    const created = await createIntent();
    expect(created.state).toBe("open");

    // Accept with ALPHA solver
    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);
    expect(acceptRes.body.state).toBe("accepted");
    expect(acceptRes.body.solver).toBe("SOLVER_ALPHA");

    // double-accept must conflict
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_BETA" })
      .expect(409);

    // wrong solver filling must be forbidden
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_BETA", fillAmount: "995000" })
      .expect(403);

    // correct solver fills
    const filled = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "995000", txHash: "e2e-hash" })
      .expect(201);
    expect(filled.body.state).toBe("filled");
    expect(filled.body.fillAmount).toBe("995000");
    expect(filled.body.txHash).toBe("e2e-hash");
  });

  it("fill amount below minimum returns the original custom error shape", async () => {
    const created = await createIntent();
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "1" })
      .expect(400);
    expect(res.body).toEqual({
      error: "Fill amount below minimum",
      fillAmount: "1",
      minDstAmount: validCreateBody.minDstAmount,
    });
  });

  it("fill with malformed minDstAmount returns 400 data integrity error", async () => {
    const created = await createIntent({ user: "GMALFORMEDMIN12345" });
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    const intentsService = app.get(IntentsService);
    await intentsService.update(created.intentId, { minDstAmount: "not-a-number" });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "995000", txHash: "e2e-hash" })
      .expect(400);
    expect(res.body.error).toBe("Data integrity error: intent minDstAmount is not a valid integer");
    expect(res.body.intentId).toBe(created.intentId);
  });

  it("POST /api/v1/intents/:id/fill with non-numeric fillAmount returns 400", async () => {
    const created = await createIntent({ user: "GFILLAMOUNT123456" });
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "abc", txHash: "e2e-hash" })
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("accept with an unknown/inactive solver is forbidden", async () => {
    const created = await createIntent();
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_UNKNOWN_XYZ" })
      .expect(403);
  });

  it("cancel: wrong user returns 403, correct user succeeds", async () => {
    const created = await createIntent();

    // Wrong user — forbidden
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: "GSOMEONEELSE1234567" })
      .expect(403);

    // Correct user cancels
    const cancelled = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: USER_KP.publicKey() })
      .expect(201);
    expect(cancelled.body.state).toBe("cancelled");
  });

  it("GET /api/v1/intents/user/:address reflects created intents", async () => {
    await createIntent();
    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/user/${USER_KP.publicKey()}`)
      .expect(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(
      res.body.intents.every((i: { user: string }) => i.user === USER_KP.publicKey()),
    ).toBe(true);
  });

  it("POST /api/v1/intents/quote returns quotes sorted by dstAmount desc", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDC",
        srcAmount: "1000000",
        dstTokenSymbol: "USDC",
      })
      .expect(201);

    expect(res.body.quotes.length).toBe(3);
    const amounts = res.body.quotes.map((q: { dstAmount: string }) => BigInt(q.dstAmount));
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i - 1] >= amounts[i]).toBe(true);
    }
    expect(res.body.bestQuote.dstAmount).toBe(res.body.quotes[0].dstAmount);
  });

  it("POST /api/v1/intents with idempotencyKey deduplicates requests", async () => {
    const idempotencyKey = "test-key-" + Date.now();
    const createBody = { ...validCreateBody, user: "GIDEMPOTENCY1234567", idempotencyKey };

    const res1 = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(createBody)
      .expect(201);

    const res2 = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(createBody)
      .expect(201);

    expect(res1.body.intentId).toBe(res2.body.intentId);
    expect(res1.body.createdAt).toBe(res2.body.createdAt);
  });

  it("POST /api/v1/intents/quote preserves precision for large 18-decimal amounts", async () => {
    const largeAmount = "1000000000000000000000000";
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDT",
        srcAmount: largeAmount,
        dstTokenSymbol: "USDC",
      })
      .expect(201);

    expect(res.body.quotes.length).toBe(3);
    const srcBigInt = BigInt(largeAmount);
    const bestQuote = BigInt(res.body.bestQuote.dstAmount);
    const minExpected = (srcBigInt * BigInt(992)) / BigInt(1000);
    expect(bestQuote >= minExpected).toBe(true);
    expect(bestQuote <= srcBigInt).toBe(true);
  });

  it("POST /api/v1/intents/quote with intentId persists quotedDstAmount on the intent", async () => {
    const created = await createIntent();
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDC",
        srcAmount: "1000000",
        dstTokenSymbol: "USDC",
        intentId: created.intentId,
      })
      .expect(201);

    expect(res.body.bestQuote).toBeTruthy();
    const quotedAmount = res.body.bestQuote.dstAmount;

    const fetchRes = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}`)
      .expect(200);
    expect(fetchRes.body.quotedDstAmount).toBe(quotedAmount);
  });
});
