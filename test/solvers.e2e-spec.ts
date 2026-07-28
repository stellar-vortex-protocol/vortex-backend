import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildRegisterMessage } from "../src/common/stellar-signature";

const ALPHA_ADDR = SEED_SOLVER_KEYPAIRS.ALPHA.publicKey();
const BETA_ADDR  = SEED_SOLVER_KEYPAIRS.BETA.publicKey();
const GAMMA_ADDR = SEED_SOLVER_KEYPAIRS.GAMMA.publicKey();

describe("SolversController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/solvers returns the leaderboard sorted by fillsCompleted desc", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/solvers").expect(200);
    expect(res.body.count).toBe(3);
    const counts = res.body.solvers.map((s: { fillsCompleted: number }) => s.fillsCompleted);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });

  it("GET /api/v1/solvers/:address returns the solver record", async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/solvers/${BETA_ADDR}`).expect(200);
    expect(res.body.name).toBe("Beta Liquidity Co");
  });

  it("GET /api/v1/solvers/:address 404s for an unknown address", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/solvers/NOPE").expect(404);
    expect(res.body).toEqual({ error: "Solver not found" });
  });

  it("GET /api/v1/solvers/:address/stats returns the computed success rate", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/solvers/${GAMMA_ADDR}/stats`)
      .expect(200);
    expect(res.body.successRate).toBeCloseTo(187 / (187 + 12), 4);
  });

  it("GET /api/v1/solvers/:address/stats 404s for an unknown address", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/solvers/NOPE/stats").expect(404);
    expect(res.body).toEqual({ error: "Solver not found" });
  });

  it("POST /api/v1/solvers/register requires a valid signature", async () => {
    const newKp = Keypair.random();
    const address = newKp.publicKey();

    // Tampered signature must be rejected
    await request(app.getHttpServer())
      .post("/api/v1/solvers/register")
      .send({
        address,
        name: "Test Solver",
        bondAmount: "10000000000",
        isActive: false,
        supportedChains: ["ethereum"],
        supportedTokens: ["USDC"],
        signature: "aW52YWxpZHNpZ25hdHVyZXBhZGRpbmc=",
      })
      .expect(401);

    // Valid signature succeeds
    const sig = newKp.sign(Buffer.from(buildRegisterMessage(address), "utf8")).toString("base64");
    const res = await request(app.getHttpServer())
      .post("/api/v1/solvers/register")
      .send({
        address,
        name: "Test Solver",
        bondAmount: "10000000000",
        isActive: false,
        supportedChains: ["ethereum"],
        supportedTokens: ["USDC"],
        signature: sig,
      })
      .expect(201);

    expect(res.body.address).toBe(address);
    expect(res.body.name).toBe("Test Solver");
    expect(res.body.isActive).toBe(false);
  });
});
