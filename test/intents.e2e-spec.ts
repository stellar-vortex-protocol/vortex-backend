import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import {
  SEED_SOLVER_KEYPAIRS,
  SEED_SOLVER_SECRETS,
} from "../src/solvers/solvers.seed";
import {
  buildAcceptMessage,
  buildFillMessage,
  buildCancelMessage,
} from "../src/common/stellar-signature";

// ---------------------------------------------------------------------------
// Test keypairs
// ---------------------------------------------------------------------------

/** A Stellar keypair used as the intent user in tests that require signing. */
const USER_KP = Keypair.fromSecret("SDBC33G6FPFXVISLHM2WXR25WYRKLCQFXBELH2RWBV3ZB3ZSO54AQR4S");

const ALPHA_KP = SEED_SOLVER_KEYPAIRS.ALPHA;
const BETA_KP  = SEED_SOLVER_KEYPAIRS.BETA;

function sign(kp: Keypair, message: string): string {
  return kp.sign(Buffer.from(message, "utf8")).toString("base64");
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

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

    // Accept with valid ALPHA solver signature
    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(created.intentId, ALPHA_KP.publicKey()));
    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(201);
    expect(accepted.body.state).toBe("accepted");
    expect(accepted.body.solver).toBe(ALPHA_KP.publicKey());

    // double-accept on a non-open intent must conflict
    const betaAcceptSig = sign(BETA_KP, buildAcceptMessage(created.intentId, BETA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: BETA_KP.publicKey(), signature: betaAcceptSig })
      .expect(409);

    // wrong solver filling must be forbidden (address mismatch, before sig check)
    const betaFillSig = sign(BETA_KP, buildFillMessage(created.intentId, BETA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: BETA_KP.publicKey(), fillAmount: "995000", signature: betaFillSig })
      .expect(403);

    // correct solver fills
    const fillSig = sign(ALPHA_KP, buildFillMessage(created.intentId, ALPHA_KP.publicKey()));
    const filled = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "995000", txHash: "e2e-hash", signature: fillSig })
      .expect(201);
    expect(filled.body.state).toBe("filled");
    expect(filled.body.fillAmount).toBe("995000");
    expect(filled.body.txHash).toBe("e2e-hash");
  });

  it("fill amount below minimum returns the original custom error shape", async () => {
    const created = await createIntent();
    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(created.intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(201);

    const fillSig = sign(ALPHA_KP, buildFillMessage(created.intentId, ALPHA_KP.publicKey()));
    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "1", signature: fillSig })
      .expect(400);
    expect(res.body).toEqual({
      error: "Fill amount below minimum",
      fillAmount: "1",
      minDstAmount: validCreateBody.minDstAmount,
    });
  });

  it("accept with an unknown/inactive solver is forbidden", async () => {
    const created = await createIntent();
    // Use a valid keypair that is NOT registered as a solver
    const unknownKp = Keypair.fromSecret("SBEEB2ZY2D25GRU4TXUARHHPQ2ASDRVQJZXWBUMW27VBVT3FCU2MEU5Q");
    const sig = sign(unknownKp, buildAcceptMessage(created.intentId, unknownKp.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: unknownKp.publicKey(), signature: sig })
      .expect(403);
  });

  it("cancel: invalid signature returns 401, wrong user returns 403, correct user+sig succeeds", async () => {
    const created = await createIntent();

    // Wrong user address (different keypair) - forbidden before sig check
    const wrongKp = Keypair.fromSecret("SBEEB2ZY2D25GRU4TXUARHHPQ2ASDRVQJZXWBUMW27VBVT3FCU2MEU5Q");
    const wrongSig = sign(wrongKp, buildCancelMessage(created.intentId));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: wrongKp.publicKey(), signature: wrongSig })
      .expect(403);

    // Correct user but invalid signature (tampered)
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: USER_KP.publicKey(), signature: "aW52YWxpZHNpZ25hdHVyZXBhZGRpbmc=" })
      .expect(401);

    // Correct user + valid signature
    const validSig = sign(USER_KP, buildCancelMessage(created.intentId));
    const cancelled = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: USER_KP.publicKey(), signature: validSig })
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

    expect(res.body.quotes.length).toBe(3); // 3 active seeded solvers
    const amounts = res.body.quotes.map((q: { dstAmount: string }) => BigInt(q.dstAmount));
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i - 1] >= amounts[i]).toBe(true);
    }
    expect(res.body.bestQuote.dstAmount).toBe(res.body.quotes[0].dstAmount);
  });
});
