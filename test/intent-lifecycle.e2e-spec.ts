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
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { IntentsService, MAX_OPEN_INTENTS_PER_USER } from "../src/intents/intents.service";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import {
  buildAcceptMessage,
  buildCancelMessage,
  buildFillMessage,
} from "../src/common/stellar-signature";
import { Intent } from "../src/intents/intents.types";

const ALPHA_KP = SEED_SOLVER_KEYPAIRS.ALPHA;
const BETA_KP = SEED_SOLVER_KEYPAIRS.BETA;
// Real keypairs: cancel/accept endpoints verify an Ed25519 signature against
// the address, so every actor in this suite must be a valid Stellar keypair.
const USER_KP = Keypair.fromSecret("SDIZIS4EXUZTSAHQM2BCYY2HQUZEB2FGQ5C3BJVSYKMU6PF5KIVEQ6V5");
const SECOND_USER_KP = Keypair.fromSecret(
  "SAVLCMY3M6DMHELYMNSIE2PYOBKOYW23NVH4IBQBPX7PDZQZUMWUWN3D",
);

function sign(kp: Keypair, msg: string): string {
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
}

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

/** Shape IntentsService.create() expects (already-resolved token objects). */
const SEED_SRC_TOKEN = {
  address: BASE_INTENT.srcTokenAddress,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  chain: "ethereum" as const,
  priceUSD: 1,
};
const SEED_DST_TOKEN = {
  contract: BASE_INTENT.dstTokenContract,
  symbol: "USDC",
  decimals: 7,
  priceUSD: 1,
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
    const alphaAcceptSig = sign(ALPHA_KP, buildAcceptMessage(intentId, ALPHA_KP.publicKey()));
    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: alphaAcceptSig })
      .expect(201);

    expect(acceptRes.body.state).toBe("accepted");
    expect(acceptRes.body.solver).toBe(ALPHA_KP.publicKey());
    expect(acceptRes.body.intentId).toBe(intentId);

    // GET after accept reflects the accepted state and solver
    const getAfterAccept = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterAccept.body.state).toBe("accepted");
    expect(getAfterAccept.body.solver).toBe(ALPHA_KP.publicKey());

    // A second accept on the same intent must be rejected with 409
    const betaAcceptSig = sign(BETA_KP, buildAcceptMessage(intentId, BETA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: BETA_KP.publicKey(), signature: betaAcceptSig })
      .expect(409);

    // A wrong solver attempting to fill must be rejected with 403
    const betaFillSig = sign(BETA_KP, buildFillMessage(intentId, BETA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: BETA_KP.publicKey(), fillAmount: "1990000", signature: betaFillSig })
      .expect(403);

    // State must still be accepted after all guard rejections
    const getAfterGuards = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterGuards.body.state).toBe("accepted");

    // ------------------------------------------------------------------
    // 3. FILL
    // ------------------------------------------------------------------
    const alphaFillSig = sign(ALPHA_KP, buildFillMessage(intentId, ALPHA_KP.publicKey()));
    const fillRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({
        solver: ALPHA_KP.publicKey(),
        fillAmount: "1990000",
        txHash: "lifecycle-e2e-tx-hash",
        signature: alphaFillSig,
      })
      .expect(201);

    expect(fillRes.body.state).toBe("filled");
    expect(fillRes.body.solver).toBe(ALPHA_KP.publicKey());
    expect(fillRes.body.fillAmount).toBe("1990000");
    expect(fillRes.body.txHash).toBe("lifecycle-e2e-tx-hash");
    expect(typeof fillRes.body.filledAt).toBe("number");

    // GET after fill — all fields must be persisted (regression for #50)
    const getAfterFill = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentId}`)
      .expect(200);
    expect(getAfterFill.body.state).toBe("filled");
    expect(getAfterFill.body.solver).toBe(ALPHA_KP.publicKey());
    expect(getAfterFill.body.fillAmount).toBe("1990000");
    expect(getAfterFill.body.txHash).toBe("lifecycle-e2e-tx-hash");
    expect(typeof getAfterFill.body.filledAt).toBe("number");

    // A filled intent must no longer be fillable
    const refillSig = sign(ALPHA_KP, buildFillMessage(intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "1990000", signature: refillSig })
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

    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(201);

    const fillSig = sign(ALPHA_KP, buildFillMessage(intentId, ALPHA_KP.publicKey()));
    const res = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "1", signature: fillSig })
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
      .send({ ...BASE_INTENT, user: USER_KP.publicKey() })
      .expect(201);
    const { intentId } = createRes.body;

    // wrong user cannot cancel
    const wrongSig = sign(SECOND_USER_KP, buildCancelMessage(intentId));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/cancel`)
      .send({ user: SECOND_USER_KP.publicKey(), signature: wrongSig })
      .expect(403);

    // correct user cancels
    const cancelSig = sign(USER_KP, buildCancelMessage(intentId));
    const cancelRes = await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/cancel`)
      .send({ user: USER_KP.publicKey(), signature: cancelSig })
      .expect(201);
    expect(cancelRes.body.state).toBe("cancelled");

    // cannot accept a cancelled intent
    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(409);
  });

  /**
   * Per-user open-intent cap (issue #473)
   *
   * Seeds exactly MAX_OPEN_INTENTS_PER_USER open intents for a dedicated user,
   * asserts the (N+1)th creation returns 409 with an explanatory message, then
   * asserts that transitioning one existing intent out of open/accepted state
   * (here: cancel) frees up the slot and allows creation to succeed again.
   *
   * NOTE: the bulk of the intents are seeded through IntentsService rather than
   * POST /api/v1/intents because that endpoint is separately throttled to 10
   * creates per user per 60 s (issue #45). The HTTP path is still what is being
   * asserted — once for the cap rejection and once for the post-cancel success.
   */
  it(`rejects the (MAX+1)th open intent for a user with 409 and succeeds again after one is cancelled`, async () => {
    const CAP_USER = SECOND_USER_KP.publicKey();
    const intentsService = app.get(IntentsService);

    const seed = (): Omit<Intent, "intentId" | "createdAt" | "state"> => ({
      user: CAP_USER,
      srcChain: "ethereum",
      srcToken: SEED_SRC_TOKEN,
      srcAmount: BASE_INTENT.srcAmount,
      dstToken: SEED_DST_TOKEN,
      minDstAmount: BASE_INTENT.minDstAmount,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });

    const createdIds: string[] = [];
    for (let i = 0; i < MAX_OPEN_INTENTS_PER_USER; i++) {
      const intent = await intentsService.create(seed());
      createdIds.push(intent.intentId);
    }

    expect(createdIds).toHaveLength(MAX_OPEN_INTENTS_PER_USER);

    // The (MAX_OPEN_INTENTS_PER_USER + 1)th attempt must fail with 409.
    const capRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: CAP_USER })
      .expect(409);

    // Error message must be distinct from the rate-limit 429 and explain the cap.
    expect(capRes.body.error).toMatch(/cap reached/i);
    expect(capRes.body.error).toMatch(String(MAX_OPEN_INTENTS_PER_USER));

    // Cancel one existing intent to free up the slot.
    const intentToCancel = createdIds[0];
    const cancelSig = sign(SECOND_USER_KP, buildCancelMessage(intentToCancel));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentToCancel}/cancel`)
      .send({ user: CAP_USER, signature: cancelSig })
      .expect(201);

    // Verify the cancelled intent is no longer open.
    const cancelledCheck = await request(app.getHttpServer())
      .get(`/api/v1/intents/${intentToCancel}`)
      .expect(200);
    expect(cancelledCheck.body.state).toBe("cancelled");

    // Now creation must succeed again — the cap is user+state-scoped, not absolute.
    const afterCancelRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...BASE_INTENT, user: CAP_USER })
      .expect(201);
    expect(afterCancelRes.body.state).toBe("open");
    expect(afterCancelRes.body.user).toBe(CAP_USER);
  });
});
