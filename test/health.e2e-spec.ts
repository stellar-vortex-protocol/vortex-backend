import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("HealthController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns service status with db field", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);

    // Top-level fields are always present.
    expect(res.body).toMatchObject({
      status: "ok",
      service: "vortex-backend",
      network: "stellar-testnet",
    });
    expect(typeof res.body.uptime).toBe("number");

    // db field is always present regardless of connectivity.
    expect(res.body.db).toBeDefined();
    expect(["ok", "unreachable"]).toContain(res.body.db.status);

    if (res.body.db.status === "ok") {
      // When the database is reachable latencyMs must be a non-negative number.
      expect(typeof res.body.db.latencyMs).toBe("number");
      expect(res.body.db.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.body.db.error).toBeUndefined();
    } else {
      // When the database is unreachable an error message must be present.
      expect(typeof res.body.db.error).toBe("string");
      expect(res.body.db.latencyMs).toBeUndefined();
    }
  });
});
