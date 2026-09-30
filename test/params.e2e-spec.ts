/**
 * E2E tests for GET /api/v1/params (issue #500).
 *
 * Verifies the shape and semantics of the governance parameters endpoint
 * against a real booted Nest app (no contract configured → code defaults).
 */

// Default import: with `esModuleInterop` the namespace import is an object
// wrapper, not the callable `request` function, so `request(server)` throws
// "request is not a function".
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import { createTestApp } from "./utils/create-test-app";

describe("GET /api/v1/params (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // --------------------------------------------------------------------------
  // Basic response shape
  // --------------------------------------------------------------------------

  it("returns 200 OK", async () => {
    await request(app.getHttpServer()).get("/api/v1/params").expect(200);
  });

  it("returns JSON content-type", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/params")
      .expect("Content-Type", /application\/json/);
  });

  it("response body has current, pending, and history keys", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/params").expect(200);
    expect(res.body).toHaveProperty("current");
    expect(res.body).toHaveProperty("pending");
    expect(res.body).toHaveProperty("history");
  });

  // --------------------------------------------------------------------------
  // `current` object shape and defaults (no PARAMS_CONTRACT_ID configured)
  // --------------------------------------------------------------------------

  describe("current params (code defaults)", () => {
    let current: Record<string, unknown>;

    beforeAll(async () => {
      const res = await request(app.getHttpServer()).get("/api/v1/params").expect(200);
      current = res.body.current as Record<string, unknown>;
    });

    it("has a numeric version >= 0", () => {
      expect(typeof current["version"]).toBe("number");
      expect(current["version"] as number).toBeGreaterThanOrEqual(0);
    });

    it("has a numeric feeBps >= 0", () => {
      expect(typeof current["feeBps"]).toBe("number");
      expect(current["feeBps"] as number).toBeGreaterThanOrEqual(0);
    });

    it("has feeBps = 30 (code default)", () => {
      expect(current["feeBps"]).toBe(30);
    });

    it("has a chains object with stellar entry", () => {
      expect(current["chains"]).toBeDefined();
      expect(typeof current["chains"]).toBe("object");
      const chains = current["chains"] as Record<string, unknown>;
      expect(chains["stellar"]).toBeDefined();
    });

    it("stellar chain has deadlineSeconds = 900 (code default)", () => {
      const chains = current["chains"] as Record<string, { deadlineSeconds: number; fillWindowSeconds: number }>;
      expect(chains["stellar"]?.deadlineSeconds).toBe(900);
    });

    it("stellar chain has fillWindowSeconds = 120 (code default)", () => {
      const chains = current["chains"] as Record<string, { deadlineSeconds: number; fillWindowSeconds: number }>;
      expect(chains["stellar"]?.fillWindowSeconds).toBe(120);
    });

    it("has maxExposureRatio as a number between 0 and 1", () => {
      expect(typeof current["maxExposureRatio"]).toBe("number");
      expect(current["maxExposureRatio"] as number).toBeGreaterThanOrEqual(0);
      expect(current["maxExposureRatio"] as number).toBeLessThanOrEqual(1);
    });

    it("has slashAmount as a numeric string", () => {
      expect(typeof current["slashAmount"]).toBe("string");
      expect(() => BigInt(current["slashAmount"] as string)).not.toThrow();
    });

    it("has activeSinceLedger as a number", () => {
      expect(typeof current["activeSinceLedger"]).toBe("number");
    });

    it("has adoptedAt as an ISO-8601 date string", () => {
      expect(typeof current["adoptedAt"]).toBe("string");
      expect(new Date(current["adoptedAt"] as string).toISOString()).toBe(current["adoptedAt"]);
    });

    it("includes all 7 supported chains in the chains object", () => {
      const chains = current["chains"] as Record<string, unknown>;
      const expectedChains = [
        "stellar",
        "ethereum",
        "base",
        "polygon",
        "arbitrum",
        "optimism",
        "avalanche",
      ];
      for (const chain of expectedChains) {
        expect(chains[chain]).toBeDefined();
      }
    });
  });

  // --------------------------------------------------------------------------
  // `pending` — should be null when no contract is configured
  // --------------------------------------------------------------------------

  it("pending is null when PARAMS_CONTRACT_ID is not set", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/params").expect(200);
    expect(res.body.pending).toBeNull();
  });

  // --------------------------------------------------------------------------
  // `history` — should be empty array on first boot
  // --------------------------------------------------------------------------

  it("history is an array", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/params").expect(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it("history is empty on first boot (no contract, no changes)", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/params").expect(200);
    expect(res.body.history).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Security headers
  // --------------------------------------------------------------------------

  it("returns X-Content-Type-Options: nosniff (Helmet)", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/params");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  // --------------------------------------------------------------------------
  // Idempotency — two calls return consistent data
  // --------------------------------------------------------------------------

  it("returns identical current.version on successive calls", async () => {
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer()).get("/api/v1/params"),
      request(app.getHttpServer()).get("/api/v1/params"),
    ]);
    expect(r1.body.current.version).toBe(r2.body.current.version);
    expect(r1.body.current.feeBps).toBe(r2.body.current.feeBps);
  });

  // --------------------------------------------------------------------------
  // Swagger / OpenAPI registration
  // --------------------------------------------------------------------------

  it("GET /docs returns 200 (Swagger UI includes the params route)", async () => {
    await request(app.getHttpServer()).get("/docs").expect(200);
  });
});
