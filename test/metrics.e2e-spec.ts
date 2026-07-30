import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

describe("MetricsController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /metrics returns prometheus metrics", async () => {
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);

    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("vortex_http_requests_total");
    expect(res.text).toContain("vortex_http_request_duration_seconds");
    expect(res.text).toContain("vortex_http_request_errors_total");
    expect(res.text).toContain("vortex_intent_state_transitions_total");
    expect(res.text).toContain("vortex_ws_connections_active");
  });

  it("GET /metrics includes default metrics (process_cpu)", async () => {
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(res.text).toContain("vortex_process_cpu_seconds");
  });
});
