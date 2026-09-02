import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestApp } from "./utils/create-test-app";
import { SEED_SOLVER_KEYPAIRS } from "../src/solvers/solvers.seed";
import { buildRegisterMessage, buildSolverStatusMessage } from "../src/common/stellar-signature";

const ALPHA_ADDR = SEED_SOLVER_KEYPAIRS.ALPHA.publicKey();
const BETA_ADDR  = SEED_SOLVER_KEYPAIRS.BETA.publicKey();
const GAMMA_ADDR = SEED_SOLVER_KEYPAIRS.GAMMA.publicKey();

function signMessage(message: string, signer: Keypair): string {
  return signer.sign(Buffer.from(message, "utf8")).toString("base64");
}

describe("SolversController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/solvers returns the leaderboard sorted by fillsCompleted desc", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/solvers")
      .expect(200);
    expect(res.body.count).toBe(3);
    const counts = res.body.solvers.map(
      (s: { fillsCompleted: number }) => s.fillsCompleted,
    );
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("GET /api/v1/solvers/:address returns the solver record", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/solvers/SOLVER_BETA")
      .expect(200);
    const counts = res.body.solvers.map((s: { fillsCompleted: number }) => s.fillsCompleted);
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });

  it("GET /api/v1/solvers/:address returns the solver record", async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/solvers/${BETA_ADDR}`).expect(200);
    expect(res.body.name).toBe("Beta Liquidity Co");
  });

  it("GET /api/v1/solvers/:address 404s for an unknown address", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/solvers/NOPE")
      .expect(404);
    expect(res.body).toEqual({ error: "Solver not found" });
  });

  it("GET /api/v1/solvers/:address/stats returns the computed success rate", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/solvers/${GAMMA_ADDR}/stats`)
      .expect(200);
    expect(res.body.successRate).toBeCloseTo(187 / (187 + 12), 4);
    expect(res.body.reputationScore).toBeGreaterThanOrEqual(0);
    expect(res.body.reputationScore).toBeLessThanOrEqual(1);
  });

  it("POST /api/v1/solvers/:address/deregister marks the solver inactive", async () => {
    const message = buildSolverStatusMessage("deregister", ALPHA_ADDR);
    const signature = signMessage(message, SEED_SOLVER_KEYPAIRS.ALPHA);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/solvers/${ALPHA_ADDR}/deregister`)
      .send({ signature })
      .expect(200);
    expect(res.body.isActive).toBe(false);
    expect(res.body.withdrawalStatus).toBe("pending");
  });

  it("GET /api/v1/solvers/:address/stats 404s for an unknown address", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/solvers/NOPE/stats").expect(404);
    expect(res.body).toEqual({ error: "Solver not found" });
  });

  it("POST /api/v1/solvers registers a new solver", async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const proofSignature = signMessage(buildRegisterMessage(address), keypair);

    const res = await request(app.getHttpServer())
      .post("/api/v1/solvers")
      .send({
        address,
        name: "New Solver Inc",
        bondAmount: "500000000",
        avgFillTime: 45,
        supportedChains: ["ethereum", "stellar"],
        supportedTokens: ["USDC", "USDT"],
        proofSignature,
      })
      .expect(201);

    expect(res.body.address).toBe("GNEWSOLVER123456789");
    expect(res.body.name).toBe("New Solver Inc");
    expect(res.body.bondAmount).toBe("500000000");
    expect(res.body.avgFillTime).toBe(45);
    expect(res.body.isActive).toBe(true);
    expect(res.body.fillsCompleted).toBe(0);
    expect(res.body.fillsFailed).toBe(0);
    expect(res.body.totalVolume).toBe("0");
    expect(res.body.registeredAt).toBeTruthy();

    // Verify the solver is now queryable
    const fetchRes = await request(app.getHttpServer())
      .get(`/api/v1/solvers/${address}`)
      .expect(200);
    expect(fetchRes.body.name).toBe("New Solver Inc");
  });

  it("POST /api/v1/solvers rejects invalid registration data", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/solvers")
      .send({
        address: "short",
        name: "Test",
        // missing required fields
      })
      .expect(400);

    expect(res.body.error).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});
