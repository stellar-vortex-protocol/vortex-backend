import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

const validCreateBody = {
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

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);
    expect(accepted.body.state).toBe("accepted");
    expect(accepted.body.solver).toBe("SOLVER_ALPHA");

    // double-accept on a non-open intent must conflict
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "SOLVER_BETA" })
      .expect(409);

    // wrong solver filling must be forbidden
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_BETA", fillAmount: "995000" })
      .expect(403);

    const filled = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "995000", txHash: "e2e-hash" })
      .expect(201);
    expect(filled.body.state).toBe("filled");
    expect(filled.body.fillAmount).toBe("995000");
    expect(filled.body.txHash).toBe("e2e-hash");
  });

  it("fill amount below minimum returns the original custom error shape", async () => {
    const created = await createIntent({ user: "GBELOWMINIMUM12345" });
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

  it("accept with an unknown/inactive solver is forbidden", async () => {
    const created = await createIntent({ user: "GUNKNOWNSOLVER12345" });
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/accept`)
      .send({ solver: "NOT_A_REAL_SOLVER" })
      .expect(403);
  });

  it("cancel by the wrong user is forbidden, by the right user succeeds", async () => {
    const created = await createIntent({ user: "GCANCELOWNER123456" });

    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: "GSOMEONEELSE1234567" })
      .expect(403);

    const cancelled = await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: "GCANCELOWNER123456" })
      .expect(201);
    expect(cancelled.body.state).toBe("cancelled");
  });

  it("GET /api/v1/intents/user/:address reflects created intents", async () => {
    await createIntent({ user: "GUSERLOOKUP12345678" });
    const res = await request(app.getHttpServer())
      .get("/api/v1/intents/user/GUSERLOOKUP12345678")
      .expect(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.intents.every((i: { user: string }) => i.user === "GUSERLOOKUP12345678")).toBe(true);
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
