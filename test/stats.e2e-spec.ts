import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildAcceptMessage, buildFillMessage } from "../src/common/stellar-signature";
import { Keypair } from "@stellar/stellar-sdk";

const ALPHA_KP = SEED_SOLVER_KEYPAIRS.ALPHA;

function sign(kp: Keypair, message: string): string {
  return kp.sign(Buffer.from(message, "utf8")).toString("base64");
}

describe("StatsController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/stats reflects the seeded data", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/stats").expect(200);

    expect(res.body.totalIntents).toBe(5);
    expect(res.body.activeSolvers).toBe(3);
    expect(res.body.fillRate).toBeCloseTo(1 / 5, 4);
  });

  it("updates after a real create -> accept -> fill cycle through the live endpoints", async () => {
    const before = await request(app.getHttpServer()).get("/api/v1/stats").expect(200);

    const createRes = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({
        user: "GSTATSE2E1234567890",
        srcChain: "ethereum",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        srcTokenSymbol: "USDC",
        srcTokenDecimals: 6,
        srcAmount: "1000000",
        dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        dstTokenSymbol: "USDC",
        dstTokenDecimals: 7,
        minDstAmount: "990000",
      })
      .expect(201);
    const intentId = createRes.body.intentId as string;

    const acceptSig = sign(ALPHA_KP, buildAcceptMessage(intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/accept`)
      .send({ solver: ALPHA_KP.publicKey(), signature: acceptSig })
      .expect(201);

    const fillSig = sign(ALPHA_KP, buildFillMessage(intentId, ALPHA_KP.publicKey()));
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/fill`)
      .send({ solver: ALPHA_KP.publicKey(), fillAmount: "995000", signature: fillSig })
      .expect(201);

    const after = await request(app.getHttpServer()).get("/api/v1/stats").expect(200);

    expect(after.body.totalIntents).toBe(before.body.totalIntents + 1);
    expect(BigInt(after.body.totalVolume) - BigInt(before.body.totalVolume)).toBe(995000n);
  });
});
