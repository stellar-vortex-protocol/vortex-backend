/**
 * Partial fills end-to-end (issue #427): create with allowPartialFill, two
 * solvers reserve tranches, one fills, the other lapses and is slashed for
 * its tranche only, a third takes the freed amount, and the intent settles.
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildReserveMessage, buildTrancheFillMessage, buildAcceptMessage } from "../src/common/stellar-signature";
import { PartialFillService } from "../src/intents/partial-fills/partial-fill.service";

const ALPHA = SEED_SOLVER_KEYPAIRS.ALPHA;
const BETA = SEED_SOLVER_KEYPAIRS.BETA;
const GAMMA = SEED_SOLVER_KEYPAIRS.GAMMA;

const sign = (kp: Keypair, msg: string) => kp.sign(Buffer.from(msg, "utf8")).toString("base64");

describe("Partial fills (e2e)", () => {
  let app: INestApplication;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createPartial(overrides: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({
        user: `GPARTIAL${String(++seq).padStart(13, "0")}`,
        srcChain: "ethereum",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        srcTokenSymbol: "USDC",
        srcTokenDecimals: 6,
        srcAmount: "1000000",
        dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        dstTokenSymbol: "USDC",
        dstTokenDecimals: 7,
        minDstAmount: "990000",
        allowPartialFill: true,
        minFillAmount: "100000",
        ...overrides,
      })
      .expect(201);
    return res.body;
  }

  const reserve = (intentId: string, kp: Keypair, amount: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/reservations`)
      .send({ solver: kp.publicKey(), amount, signature: sign(kp, buildReserveMessage(intentId, kp.publicKey(), amount)) });

  const fillTranche = (intentId: string, fillId: string, kp: Keypair, dstAmount: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/intents/${intentId}/reservations/${fillId}/fill`)
      .send({
        solver: kp.publicKey(),
        dstAmount,
        txHash: `tx-${fillId}`,
        signature: sign(kp, buildTrancheFillMessage(intentId, fillId, kp.publicKey(), dstAmount)),
      });

  it("exposes allowPartialFill and an empty fillProgress on create", async () => {
    const intent = await createPartial();
    expect(intent).toMatchObject({
      state: "open",
      allowPartialFill: true,
      minFillAmount: "100000",
      fillProgress: { status: "none", remainingAmount: "1000000", reservedAmount: "0" },
    });
  });

  it("runs reserve → fill → lapse/slash → re-reserve → settle", async () => {
    const intent = await createPartial();
    const id = intent.intentId as string;

    const a = await reserve(id, ALPHA, "600000").expect(201);
    const b = await reserve(id, BETA, "400000").expect(201);
    expect(b.body.intent.fillProgress).toMatchObject({ reservedAmount: "1000000", remainingAmount: "0" });

    // Nothing left: a third reservation conflicts and reports the remainder.
    const over = await reserve(id, GAMMA, "100000").expect(409);
    expect(over.body).toMatchObject({ remainingAmount: "0" });

    // Alpha fills its 60% tranche (pro-rata min = 990000 × 0.6 = 594000).
    await fillTranche(id, a.body.fill.fillId, ALPHA, "593999").expect(400);
    const filledA = await fillTranche(id, a.body.fill.fillId, ALPHA, "594000").expect(200);
    expect(filledA.body).toMatchObject({
      settled: false,
      intent: { state: "open", fillProgress: { status: "partially_filled", filledAmount: "600000" } },
    });

    // Beta's reservation lapses: slash at its deadline.
    const partialFills = app.get(PartialFillService);
    expect(await partialFills.slashExpiredReservations(b.body.fill.deadline)).toBe(1);
    const afterSlash = await request(app.getHttpServer()).get(`/api/v1/intents/${id}/fills`).expect(200);
    expect(afterSlash.body.fillProgress).toMatchObject({ reservedAmount: "0", remainingAmount: "400000", filledAmount: "600000" });
    expect(afterSlash.body.fills.map((f: { status: string }) => f.status).sort()).toEqual(["filled", "slashed"]);
    const history = await request(app.getHttpServer()).get(`/api/v1/solvers/${BETA.publicKey()}/slashes`);
    if (history.status === 200) {
      expect(JSON.stringify(history.body)).toContain(id);
    }

    // Gamma takes the freed 40% and fills it; the intent settles.
    const c = await reserve(id, GAMMA, "400000").expect(201);
    const filledC = await fillTranche(id, c.body.fill.fillId, GAMMA, "396000").expect(200);
    expect(filledC.body.settled).toBe(true);
    expect(filledC.body.intent).toMatchObject({
      state: "filled",
      fillAmount: "990000",
      fillProgress: { status: "filled", filledAmount: "1000000", fillCount: 2 },
    });

    const audit = await request(app.getHttpServer()).get(`/api/v1/intents/${id}/audit?limit=100`).expect(200);
    const reasons = audit.body.entries.map((e: { reason: string }) => e.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(["solver reserved tranche", "solver filled tranche", "tranche reservation slashed", "all tranches filled"]),
    );
  });

  it("refuses the all-or-nothing accept on a partial-fill intent", async () => {
    const intent = await createPartial();
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intent.intentId}/accept`)
      .send({ solver: ALPHA.publicKey(), signature: sign(ALPHA, buildAcceptMessage(intent.intentId, ALPHA.publicKey())) })
      .expect(409);
  });

  it("rejects a reservation signed for a different amount", async () => {
    const intent = await createPartial();
    await request(app.getHttpServer())
      .post(`/api/v1/intents/${intent.intentId}/reservations`)
      .send({
        solver: ALPHA.publicKey(),
        amount: "500000",
        signature: sign(ALPHA, buildReserveMessage(intent.intentId, ALPHA.publicKey(), "100000")),
      })
      .expect(401);
  });

  it("validates partial-fill terms on create", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/intents")
      .send({
        user: `GPARTIAL${String(++seq).padStart(13, "0")}`,
        srcChain: "ethereum",
        srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        srcTokenSymbol: "USDC",
        srcTokenDecimals: 6,
        srcAmount: "1000",
        dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        dstTokenSymbol: "USDC",
        dstTokenDecimals: 7,
        minDstAmount: "990",
        allowPartialFill: true,
        minFillAmount: "5000",
      })
      .expect(400);
  });
});
