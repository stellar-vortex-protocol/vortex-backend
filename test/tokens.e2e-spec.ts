import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("TokensController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/tokens with no filter returns the full registry plus Stellar tokens", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/tokens").expect(200);
    expect(res.body.tokens).toHaveProperty("ethereum");
    expect(res.body).toHaveProperty("stellarTokens");
  });

  it("GET /api/v1/tokens?chain=polygon returns only that chain's tokens", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/tokens")
      .query({ chain: "polygon" })
      .expect(200);
    expect(res.body.chain).toBe("polygon");
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens.every((t: { symbol: string }) => typeof t.symbol === "string")).toBe(true);
  });

  it("GET /api/v1/tokens?chain=stellar returns Stellar tokens", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/tokens")
      .query({ chain: "stellar" })
      .expect(200);
    expect(res.body.chain).toBe("stellar");
  });

  it("GET /api/v1/tokens/stellar returns Stellar tokens directly", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/tokens/stellar").expect(200);
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/tokens?chain=unknown falls back to the full registry", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/tokens")
      .query({ chain: "not-a-real-chain" })
      .expect(200);
    expect(res.body.tokens).toHaveProperty("ethereum");
    expect(res.body).toHaveProperty("stellarTokens");
  });
});
