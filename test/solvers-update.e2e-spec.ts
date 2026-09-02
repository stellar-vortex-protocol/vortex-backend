import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildUpdateSolverMessage } from "../src/common/stellar-signature";
import { createTestApp } from "./utils/create-test-app";

/**
 * Issue #273 — PATCH /api/v1/solvers/:address
 */
const ALPHA = SEED_SOLVER_KEYPAIRS.ALPHA;
const ALPHA_ADDR = ALPHA.publicKey();

function sign(address: string): string {
  return ALPHA.sign(Buffer.from(buildUpdateSolverMessage(address), "utf8")).toString("base64");
}

describe("PATCH /api/v1/solvers/:address (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("updates mutable profile fields with a valid signature", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${ALPHA_ADDR}`)
      .send({
        name: "Alpha MM (updated)",
        supportedChains: ["ethereum", "stellar"],
        supportedTokens: ["USDC", "WETH"],
        avgFillTime: 41,
        signature: sign(ALPHA_ADDR),
      })
      .expect(200);

    expect(res.body.name).toBe("Alpha MM (updated)");
    expect(res.body.supportedChains).toEqual(["ethereum", "stellar"]);
    expect(res.body.supportedTokens).toEqual(["USDC", "WETH"]);
    expect(res.body.avgFillTime).toBe(41);
  });

  it("silently strips immutable fields (whitelist: true) rather than erroring", async () => {
    const before = (await request(app.getHttpServer()).get(`/api/v1/solvers/${ALPHA_ADDR}`)).body;

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${ALPHA_ADDR}`)
      .send({
        name: "Alpha renamed",
        bondAmount: "1",
        fillsCompleted: 999999,
        isActive: false,
        registeredAt: 0,
        signature: sign(ALPHA_ADDR),
      })
      .expect(200);

    expect(res.body.name).toBe("Alpha renamed");
    expect(res.body.bondAmount).toBe(before.bondAmount);
    expect(res.body.fillsCompleted).toBe(before.fillsCompleted);
    expect(res.body.isActive).toBe(before.isActive);
    expect(res.body.registeredAt).toBe(before.registeredAt);
  });

  it("rejects a missing signature with 400", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${ALPHA_ADDR}`)
      .send({ name: "no sig" })
      .expect(400);
  });

  it("rejects an invalid signature with 401", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${ALPHA_ADDR}`)
      .send({ name: "bad sig", signature: Buffer.from("not-a-real-signature").toString("base64") })
      .expect(401);
  });

  it("rejects a signature from the wrong key with 401", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${ALPHA_ADDR}`)
      .send({
        name: "wrong signer",
        signature: SEED_SOLVER_KEYPAIRS.BETA.sign(
          Buffer.from(buildUpdateSolverMessage(ALPHA_ADDR), "utf8"),
        ).toString("base64"),
      })
      .expect(401);
  });

  it("rejects an unsupported chain with 400", async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${ALPHA_ADDR}`)
      .send({ supportedChains: ["ethereum", "solana"], signature: sign(ALPHA_ADDR) })
      .expect(400);
  });

  it("404s for a valid but unregistered solver address", async () => {
    const stranger = Keypair.random();
    const addr = stranger.publicKey();
    await request(app.getHttpServer())
      .patch(`/api/v1/solvers/${addr}`)
      .send({
        name: "ghost",
        signature: stranger
          .sign(Buffer.from(buildUpdateSolverMessage(addr), "utf8"))
          .toString("base64"),
      })
      .expect(404);
  });
});
