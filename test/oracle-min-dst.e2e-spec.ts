import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { buildHighSlippageAckMessage } from "../src/common/stellar-signature";

const USER_KP = Keypair.fromSecret("SDIZIS4EXUZTSAHQM2BCYY2HQUZEB2FGQ5C3BJVSYKMU6PF5KIVEQ6V5");

function sign(kp: Keypair, msg: string): string {
  return kp.sign(Buffer.from(msg, "utf8")).toString("base64");
}

const body = {
  user: USER_KP.publicKey(),
  srcChain: "ethereum" as const,
  srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "1000000",
  dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 7,
};

describe("oracle minDstAmount validation (e2e, #434)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts a 1% min and returns fairValue plus slippageBps", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...body, minDstAmount: "9900000" })
      .expect(201);
    expect(res.body.fairValue).toBe("10000000");
    expect(res.body.slippageBps).toBe("100");
  });

  it("rejects minDstAmount below MAX_USER_SLIPPAGE_BPS", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...body, minDstAmount: "9899000" })
      .expect(400);
    expect(res.body.code).toBe("EXCESSIVE_SLIPPAGE");
    expect(res.body.fairValue).toBe("10000000");
  });

  it("accepts acknowledged high slippage when the user signs", async () => {
    const minDstAmount = "5000000";
    const signature = sign(
      USER_KP,
      buildHighSlippageAckMessage(USER_KP.publicKey(), body.srcAmount, minDstAmount),
    );
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({
        ...body,
        minDstAmount,
        acknowledgeHighSlippage: true,
        highSlippageSignature: signature,
      })
      .expect(201);
    expect(BigInt(res.body.slippageBps)).toBeGreaterThan(100n);
  });

  it("rejects minDstAmount above MAX_PREMIUM_BPS", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...body, minDstAmount: "10051000" })
      .expect(400);
    expect(res.body.code).toBe("EXCESSIVE_PREMIUM");
  });

  it("rejects acknowledgeHighSlippage without a signature", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({ ...body, minDstAmount: "5000000", acknowledgeHighSlippage: true })
      .expect(400);
  });
});
