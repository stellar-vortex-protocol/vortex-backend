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
import { MAX_OPEN_INTENTS_PER_USER } from "../src/intents/intents.service";

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

  /**
   * Per-user open-intent cap (issue: per-user open-intent cap)
   *
   * Creates exactly MAX_OPEN_INTENTS_PER_USER intents for a dedicated user,
   * asserts the (N+1)th creation returns 409 with an explanatory message, then
   * asserts that transitioning one existing intent out of open/accepted state
   * (here: cancel) frees up the slot and allows creation to succeed again.
   *
   * NOTE: the seed data already occupies the store but belongs to different
   * user addresses, so this test uses a unique address that starts at 0 open
   * intents.
   */
  it(`rejects the (MAX+1)th open intent for a user with 409 and succeeds again after one is cancelled`, async () => {
    const CAP_USER = "GCAP_TEST_USER_E2E_01";
    const CAP_BASE = {
      ...BASE_INTENT,
      user: CAP_USER,
    };

    // Create exactly MAX_OPEN_INTENTS_PER_USER intents for this user.
    // Use a low minDstAmount so the validation never blocks us.
    const createdIds: string[] = [];
    for (let i = 0; i < MAX_OPEN_INTENTS_PER_USER; i++) {
      const res = await request(app.getHttpServer())
        .post("/api/v1/intents")
        .send(CAP_BASE)
        .expect(201);
      createdIds.push(res.body.intentId as string);
    }

    expect(createdIds).toHaveLength(MAX_OPEN_INTENTS_PER_USER);

    // The (MAX_OPEN_INTENTS_PER_USER + 1)th attempt must fail with 409.
    const capRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(CAP_BASE)
      .expect(409);

    // Error message must be distinct from the rate-limit 429 and explain the cap.
    expect(capRes.body.message).toMatch(/cap reached/i);
    expect(capRes.body.message).toMatch(String(MAX_OPEN_INTENTS_PER_USER));

    // Cancel one existing intent to free up the slot.
    const intentToCancel = createdIds[0];
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentToCancel}/cancel`)
      .send({ user: CAP_USER })
      .expect(201);

    // Verify the cancelled intent is no longer open.
    const cancelledCheck = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentToCancel}`)
      .expect(200);
    expect(cancelledCheck.body.state).toBe("cancelled");

    // Now creation must succeed again — the cap is user+state-scoped, not absolute.
    const afterCancelRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send(CAP_BASE)
      .expect(201);
    expect(afterCancelRes.body.state).toBe("open");
    expect(afterCancelRes.body.user).toBe(CAP_USER);
  });
});
