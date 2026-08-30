import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { IntentsService } from "../src/intents/intents.service";
import { buildCancelMessage, verifyStellarSignature } from "../src/common/stellar-signature";

const USER_KP = Keypair.fromSecret("SCZANGBA5YELHNOHPQLUIZ6MFJLCVX5BPXTBXCMD5SBKX60RCVHQQHK");

function sign(kp: Keypair, msg: string): string {
  const msgBuf = Buffer.from(msg, "utf8");
  return kp.sign(msgBuf).toString("base64");
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

describe("Audit trail e2e (#217)", () => {
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

  it("GET /api/v1/intents/:id/audit returns 404 for an unknown intentId", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/intents/does-not-exist/audit")
      .expect(404);
  });

  it("GET /api/v1/intents/:id/audit returns an empty entries array for a freshly created intent", async () => {
    const created = await createIntent();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/audit`)
      .expect(200);

    expect(res.body.intentId).toBe(created.intentId);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries).toHaveLength(0);
  });

  it("GET /api/v1/intents/:id/audit reflects a cancel entry", async () => {
    const created = await createIntent();
    const sig = sign(USER_KP, buildCancelMessage(created.intentId));

    await request(app.getHttpServer())
      .post(`/api/v1/intents/${created.intentId}/cancel`)
      .send({ user: USER_KP.publicKey(), signature: sig })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/audit`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    const entry = res.body.entries[0];
    expect(entry.toState).toBe("cancelled");
    expect(entry.actor).toBe(USER_KP.publicKey());
    expect(entry.reason).toBe("user cancelled");
    expect(entry.timestamp).toBeTruthy();
  });

  it("GET /api/v1/intents/:id/audit reflects expiry via the sweeper", async () => {
    // Create an intent and force-expire it via IntentsService directly
    const created = await createIntent();
    const intentsService = app.get(IntentsService);

    // Manually set to expired state and append an audit entry (simulating sweeper)
    intentsService.update(created.intentId, { state: "expired" });
    intentsService.appendAuditEntry(
      created.intentId,
      "expired",
      "system",
      "deadline passed",
      { deadline: Math.floor(Date.now() / 1000) - 1 },
    );

    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/audit`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    const entry = res.body.entries[0];
    expect(entry.toState).toBe("expired");
    expect(entry.actor).toBe("system");
    expect(entry.reason).toBe("deadline passed");
    expect(entry.metadata).toBeDefined();
  });

  it("GET /api/v1/intents/:id/audit reflects a slash entry", async () => {
    const created = await createIntent();
    const intentsService = app.get(IntentsService);

    // Simulate sweeper slashing
    intentsService.update(created.intentId, {
      state: "slashed",
      slashedAt: Math.floor(Date.now() / 1000),
      slashReason: "accepted intent not filled before deadline",
    });
    intentsService.appendAuditEntry(
      created.intentId,
      "slashed",
      "system",
      "accepted intent not filled before deadline",
    );

    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/audit`)
      .expect(200);

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].toState).toBe("slashed");
    expect(res.body.entries[0].actor).toBe("system");
  });

  it("GET /api/v1/intents/:id/audit returns entries oldest-first for multiple transitions", async () => {
    const created = await createIntent();
    const intentsService = app.get(IntentsService);

    intentsService.appendAuditEntry(created.intentId, "accepted", "SOLVER_A", "solver accepted");
    intentsService.appendAuditEntry(created.intentId, "filled", "SOLVER_A", "solver filled");

    const res = await request(app.getHttpServer())
      .get(`/api/v1/intents/${created.intentId}/audit`)
      .expect(200);

    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0].toState).toBe("accepted");
    expect(res.body.entries[1].toState).toBe("filled");
  });
});
