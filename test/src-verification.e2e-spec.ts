import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { IntentsService } from "../src/intents/intents.service";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildAcceptMessage } from "../src/common/stellar-signature";

/**
 * Issue #403 — with EVM_DEPOSIT_VERIFICATION_ENABLED, EVM-source intents are
 * created unverified: hidden from GET /intents/open by default and rejected
 * by accept() until their escrow deposit is confirmed.
 */
describe("Source-deposit verification (e2e)", () => {
  let app: INestApplication;
  const previous = process.env.EVM_DEPOSIT_VERIFICATION_ENABLED;

  beforeAll(async () => {
    process.env.EVM_DEPOSIT_VERIFICATION_ENABLED = "true";
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (previous === undefined) delete process.env.EVM_DEPOSIT_VERIFICATION_ENABLED;
    else process.env.EVM_DEPOSIT_VERIFICATION_ENABLED = previous;
  });

  const body = {
    user: Keypair.random().publicKey(),
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

  function accept(intentId: string) {
    const solver = SEED_SOLVER_KEYPAIRS.ALPHA;
    return request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({
        solver: solver.publicKey(),
        signature: solver.sign(Buffer.from(buildAcceptMessage(intentId, solver.publicKey()), "utf8")).toString("base64"),
      });
  }

  it("creates EVM intents unverified, stores srcTxHash, and hides them from /open", async () => {
    const srcTxHash = `0x${"AB".repeat(32)}`;
    const created = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...body, srcTxHash })
      .expect(201);
    expect(created.body).toMatchObject({ srcVerified: false, srcTxHash: srcTxHash.toLowerCase(), srcVerification: { status: "pending" } });

    const open = await request(app.getHttpServer()).get("/api/v1/intents/open").query({ limit: 100 }).expect(200);
    expect(open.body.intents.map((i: { intentId: string }) => i.intentId)).not.toContain(created.body.intentId);
    expect(open.body.intents.every((i: { srcVerified: boolean }) => i.srcVerified)).toBe(true);

    const all = await request(app.getHttpServer())
      .get("/api/v1/intents/open")
      .query({ limit: 100, includeUnverified: "true" })
      .expect(200);
    expect(all.body.intents.map((i: { intentId: string }) => i.intentId)).toContain(created.body.intentId);
  });

  it("rejects a malformed srcTxHash", async () => {
    await request(app.getHttpServer()).post("/api/v1/intents").send({ ...body, srcTxHash: "0x1234" }).expect(400);
  });

  it("refuses to let a solver accept an unverified intent, and allows it once verified", async () => {
    const created = (await request(app.getHttpServer()).post("/api/v1/intents").send(body).expect(201)).body;

    const refused = await accept(created.intentId).expect(409);
    expect(refused.body.message ?? refused.body.error).toMatch(/not verified/);

    // Simulate the verifier confirming the deposit.
    const intents = app.get(IntentsService);
    await intents.update(
      created.intentId,
      { srcVerified: true, srcVerification: { status: "verified", checkedAt: Math.floor(Date.now() / 1000) } },
      created.version,
    );

    await accept(created.intentId).expect(201);
  });
});
