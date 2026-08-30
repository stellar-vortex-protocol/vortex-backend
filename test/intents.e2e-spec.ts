import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { IntentsService } from "../src/intents/intents.service";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import {
  buildAcceptMessage,
  buildCancelMessage,
  buildFillMessage,
} from "../src/common/stellar-signature";

// Known user keypair whose public key is a valid Stellar G… address
const USER_KP = Keypair.fromSecret("SCZANGBA5YELHNOHPQLUIZ6MFJLCVX5BPXTBXCMD5SBKX60RCVHQQHK");
const ALPHA_KP = SEED_SOLVER_KEYPAIRS.ALPHA;
const BETA_KP = SEED_SOLVER_KEYPAIRS.BETA;

function sign(kp: Keypair, msg: string): string {
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
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
    const created = await createIntent();
    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(created.intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(201);

    const intentsService = app.get(IntentsService);
    await intentsService.update(created.intentId, { minDstAmount: "not-a-number" });

    const fillSig = sign(ALPHA_KP, buildFillMessage(created.intentId, ALPHA_KP.publicKey()));
    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "995000", txHash: "e2e-hash", signature: fillSig })
      .expect(400);
    expect(res.body.error).toBe("Data integrity error: intent minDstAmount is not a valid integer");
    expect(res.body.intentId).toBe(created.intentId);
  });

  it("POST /api/v1/intents/:id/fill with non-numeric fillAmount returns 400", async () => {
    const created = await createIntent();
    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(created.intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(201);

    const fillSig = sign(ALPHA_KP, buildFillMessage(created.intentId, ALPHA_KP.publicKey()));
    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "abc", txHash: "e2e-hash", signature: fillSig })
      .expect(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it("accept with an unknown/inactive solver is forbidden", async () => {
    const created = await createIntent();
    const unknownKp = Keypair.fromSecret("SBEEB2ZY2D25GRU4TXUARHHPQ2ASDRVQJZXWBUMW27VBVT3FCU2MEU5Q");
    const sig = sign(unknownKp, buildAcceptMessage(created.intentId, unknownKp.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_UNKNOWN_XYZ" })
      .expect(403);
  });

  it("cancel: wrong user returns 403, correct user succeeds", async () => {
    const created = await createIntent();

    const wrongKp = Keypair.fromSecret("SBEEB2ZY2D25GRU4TXUARHHPQ2ASDRVQJZXWBUMW27VBVT3FCU2MEU5Q");
    const wrongSig = sign(wrongKp, buildCancelMessage(created.intentId));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: "GSOMEONEELSE1234567" })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: USER_KP.publicKey(), signature: "aW52YWxpZHNpZ25hdHVyZXBhZGRpbmc=" })
      .expect(401);

    const validSig = sign(USER_KP, buildCancelMessage(created.intentId));
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
    expect(bestQuote <= maxExpected).toBe(true);

    for (const quote of res.body.quotes) {
      const amount = BigInt(quote.dstAmount);
      expect(amount >= minExpected).toBe(true);
      expect(amount <= maxExpected).toBe(true);
    }
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

  // ── #219: resolveToken used in create and quote ────────────────────────────

  it("POST /api/v1/intents create resolves srcToken priceUSD from registry", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({
        ...validCreateBody,
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // known USDC
      })
      .expect(201);

    // priceUSD should be 1.0 from the registry, not undefined
    expect(res.body.srcToken.priceUSD).toBe(1.0);
  });

  it("POST /api/v1/intents create with unknown srcToken address still succeeds (priceUSD undefined)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({
        ...validCreateBody,
        srcTokenAddress: "0xunknowntoken000000000000000000000000000",
      })
      .expect(201);

    // priceUSD should be undefined (not found in registry)
    expect(res.body.srcToken.priceUSD).toBeUndefined();
  });

  it("POST /api/v1/intents/quote includes route.steps in each quote (#220)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDC",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        srcAmount: "1000000",
        dstTokenSymbol: "USDC",
      })
      .expect(201);

    expect(res.body.quotes.length).toBeGreaterThan(0);
    for (const quote of res.body.quotes) {
      expect(quote.route).toBeDefined();
      expect(Array.isArray(quote.route.steps)).toBe(true);
      expect(quote.route.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("POST /api/v1/intents/quote direct route (USDC→USDC) has 1 step of type 'transfer' (#220)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDC",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        srcAmount: "1000000",
        dstTokenSymbol: "USDC",
      })
      .expect(201);

    const best = res.body.bestQuote;
    expect(best.route.steps).toHaveLength(1);
    expect(best.route.steps[0].type).toBe("transfer");
    expect(best.route.steps[0].fromChain).toBe("ethereum");
    expect(best.route.steps[0].toChain).toBe("stellar");
  });

  it("POST /api/v1/intents/quote two-hop route (WETH→XLM) has 2 steps (#220)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "WETH",
        srcTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        dstTokenContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        srcAmount: "1000000000000000000",
        dstTokenSymbol: "XLM",
      })
      .expect(201);

    const best = res.body.bestQuote;
    expect(best.route.steps).toHaveLength(2);
    expect(best.route.steps[0].type).toBe("swap");
    expect(best.route.steps[1].type).toBe("bridge");
  });

  it("POST /api/v1/intents/quote route.steps have well-formed fromToken and toToken", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDC",
        srcAmount: "1000000",
        dstTokenSymbol: "USDC",
      })
      .expect(201);

    for (const quote of res.body.quotes) {
      for (const step of quote.route.steps) {
        expect(typeof step.fromToken).toBe("object");
        expect(typeof step.toToken).toBe("object");
        expect(typeof step.estimatedTime).toBe("number");
        expect(typeof step.estimatedGas).toBe("string");
      }
    }
  });

  it("GET /api/v1/intents/:id/quote returns the persisted quote", async () => {
    const created = await createIntent();
    const quoteRes = await request(app.getHttpServer())
      .post("/api/v1/intents/quote")
      .send({
        srcChain: "ethereum",
        srcTokenSymbol: "USDC",
        srcAmount: "1000000",
        dstTokenSymbol: "USDC",
        intentId: created.intentId,
      })
      .expect(201);

    const quotedAmount = quoteRes.body.bestQuote.dstAmount;

    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/quote`)
      .expect(200);

    expect(res.body.intentId).toBe(created.intentId);
    expect(res.body.quotedDstAmount).toBe(quotedAmount);
  });

  it("GET /api/v1/intents/:id/quote returns 404 if no quote exists", async () => {
    const created = await createIntent();
    await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/quote`)
      .expect(404);
  });
});
