import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

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
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("GET /api/v1/solvers/:address returns the solver record", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/solvers/SOLVER_BETA").expect(200);
    expect(res.body.name).toBe("Beta Liquidity Co");
  });

  it("GET /api/v1/solvers/:address 404s for an unknown address", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/solvers/NOPE").expect(404);
    expect(res.body).toEqual({ error: "Solver not found" });
  });

  it("GET /api/v1/solvers/:address/stats returns the computed success rate", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/solvers/SOLVER_GAMMA/stats")
      .expect(200);
    expect(res.body.successRate).toBeCloseTo(187 / (187 + 12), 4);
  });

  it("GET /api/v1/solvers/:address/stats 404s for an unknown address", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/solvers/NOPE/stats")
      .expect(404);
    expect(res.body).toEqual({ error: "Solver not found" });
  });
});
