import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("HealthController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns service status (degraded if Soroban unreachable)", async () => {
    const res = await request(app.getHttpServer()).get("/health");

    if (res.status === 200) {
      expect(res.body).toMatchObject({
        status: "ok",
        service: "vortex-backend",
        network: "stellar-testnet",
      });
      expect(res.body.soroban).toBeDefined();
      expect(typeof res.body.uptime).toBe("number");
    } else {
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        status: "degraded",
        service: "vortex-backend",
        network: "stellar-testnet",
      });
      expect(res.body.soroban).toEqual({ status: "unreachable" });
      expect(typeof res.body.uptime).toBe("number");
    }
  });
});
