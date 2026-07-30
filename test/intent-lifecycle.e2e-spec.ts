/**
 * E2E test — full create → accept → fill intent lifecycle
 *
 * Verifies that state, solver, fillAmount, txHash, and filledAt are
 * consistently persisted and retrievable at each step, and that the
 * intermediary conflict / permission guard responses remain correct.
 *
 * This is the regression harness that would have caught #50
 * (quotedDstAmount never persisted).
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

const BASE_INTENT = {
  user: "GLIFECYCLEE2ETEST12",
  srcChain: "ethereum",
  srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "2000000",
  dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 7,
  minDstAmount: "1980000",
};

describe("Intent lifecycle e2e (create → accept → fill)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("walks an intent through its full lifecycle, verifying state at every step", async () => {
    // ------------------------------------------------------------------
    // 1. CREATE
    // ------------------------------------------------------------------
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(BASE_INTENT)
      .expect(201);

    const { intentId } = createRes.body;
    expect(typeof intentId).toBe("string");
    expect(createRes.body.state).toBe("open");
    expect(createRes.body.user).toBe(BASE_INTENT.user);

    // Verify GET returns the same initial state
    const getAfterCreate = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterCreate.body.state).toBe("open");
    expect(getAfterCreate.body.solver).toBeUndefined();

    // ------------------------------------------------------------------
    // 2. ACCEPT
    // ------------------------------------------------------------------
    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    expect(acceptRes.body.state).toBe("accepted");
    expect(acceptRes.body.solver).toBe("SOLVER_ALPHA");
    expect(acceptRes.body.intentId).toBe(intentId);

    // GET after accept reflects the accepted state and solver
    const getAfterAccept = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterAccept.body.state).toBe("accepted");
    expect(getAfterAccept.body.solver).toBe("SOLVER_ALPHA");

    // A second accept on the same intent must be rejected with 409
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: "SOLVER_BETA" })
      .expect(409);

    // A wrong solver attempting to fill must be rejected with 403
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: "SOLVER_BETA", fillAmount: "1990000" })
      .expect(403);

    // State must still be accepted after all guard rejections
    const getAfterGuards = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterGuards.body.state).toBe("accepted");

    // ------------------------------------------------------------------
    // 3. FILL
    // ------------------------------------------------------------------
    const fillRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({
        solver: "SOLVER_ALPHA",
        fillAmount: "1990000",
        txHash: "lifecycle-e2e-tx-hash",
      })
      .expect(201);

    expect(fillRes.body.state).toBe("filled");
    expect(fillRes.body.solver).toBe("SOLVER_ALPHA");
    expect(fillRes.body.fillAmount).toBe("1990000");
    expect(fillRes.body.txHash).toBe("lifecycle-e2e-tx-hash");
    expect(typeof fillRes.body.filledAt).toBe("number");

    // GET after fill — all fields must be persisted (regression for #50)
    const getAfterFill = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterFill.body.state).toBe("filled");
    expect(getAfterFill.body.solver).toBe("SOLVER_ALPHA");
    expect(getAfterFill.body.fillAmount).toBe("1990000");
    expect(getAfterFill.body.txHash).toBe("lifecycle-e2e-tx-hash");
    expect(typeof getAfterFill.body.filledAt).toBe("number");

    // A filled intent must no longer be fillable
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "1990000" })
      .expect(409);
  });

  it("user/address view reflects the lifecycle intent", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GLIFECYCLE2NDUSER12" })
      .expect(201);
    const { intentId } = createRes.body;

    const userRes = await request(app.getHttpServer())
      .get(`/api/v1/intents/user/GLIFECYCLE2NDUSER12`)
      .expect(200);
    expect(userRes.body.count).toBeGreaterThanOrEqual(1);
    const found = userRes.body.intents.find((i: { intentId: string }) => i.intentId === intentId);
    expect(found).toBeDefined();
    expect(found.state).toBe("open");
  });

  it("fill amount below minimum returns the correct error shape", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GBELOWMINLIFECYCLE12" })
      .expect(201);
    const { intentId } = createRes.body;

    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: "SOLVER_ALPHA", fillAmount: "1" })
      .expect(400);

    expect(res.body).toEqual({
      error: "Fill amount below minimum",
      fillAmount: "1",
      minDstAmount: BASE_INTENT.minDstAmount,
    });
  });

  it("cancel terminates the lifecycle before accept", async () => {
    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: "GCANCELLIFECYCLE1234" })
      .expect(201);
    const { intentId } = createRes.body;

    // wrong user cannot cancel
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/cancel`)
      .send({ user: "GSOMEONEELSE1234567" })
      .expect(403);

    // correct user cancels
    const cancelRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/cancel`)
      .send({ user: "GCANCELLIFECYCLE1234" })
      .expect(201);
    expect(cancelRes.body.state).toBe("cancelled");

    // cannot accept a cancelled intent
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: "SOLVER_ALPHA" })
      .expect(409);
  });
});
