import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";

/**
 * E2E coverage for the shadow-mode divergence monitor's report endpoint
 * (issue #401).
 *
 * The monitor is disabled by default, so these tests assert the *shape* of the
 * report and the "dark monitor is visible" property rather than any divergence
 * counts: a zeroed report must be unmistakably a report from a monitor that has
 * never run, never a claim that the off-chain and on-chain paths agree.
 */
describe("GET /api/v1/admin/shadow-report (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with the full report shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report")
      .expect(200);

    expect(res.body).toMatchObject({
      enabled: expect.any(Boolean),
      sampleRate: expect.any(Number),
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      generatedAt: expect.any(String),
      compared: expect.any(Number),
      diverged: expect.any(Number),
      divergenceRate: expect.any(Number),
    });
    expect(Array.isArray(res.body.transitions)).toBe(true);
    expect(Array.isArray(res.body.divergences)).toBe(true);
    expect(Array.isArray(res.body.daily)).toBe(true);
    expect(res.body.queue).toMatchObject({
      depth: expect.any(Number),
      capacity: expect.any(Number),
      dropped: expect.any(Number),
      sampledOut: expect.any(Number),
      disabled: expect.any(Number),
      completed: expect.any(Number),
    });
  });

  it("lists all five intent transitions even when nothing has been observed", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report")
      .expect(200);

    expect(res.body.transitions.map((t: { transition: string }) => t.transition)).toEqual([
      "accept",
      "fill",
      "cancel",
      "expire",
      "slash",
    ]);
  });

  it("reports a zero divergence rate rather than NaN when nothing was compared", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report")
      .expect(200);

    expect(Number.isNaN(res.body.divergenceRate)).toBe(false);
    expect(res.body.divergenceRate).toBe(0);
  });

  it("bounds the per-day breakdown by the requested window", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report?days=7")
      .expect(200);
    // The monitor is off, so there is nothing recorded to break down yet; the
    // assertion is that a wider window stays within the requested bound rather
    // than materialising empty buckets.
    expect(res.body.daily.length).toBeLessThanOrEqual(7);
  });

  it("rejects a non-integer days parameter instead of coercing it", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report?days=abc")
      .expect(400);
  });

  it("rejects a days value beyond the retention window", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report?days=100000")
      .expect(400);
  });

  it("exposes the monitor as disabled when SHADOW_MODE_ENABLED is off", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/admin/shadow-report")
      .expect(200);

    // The suite does not set SHADOW_MODE_ENABLED, so the default applies. This
    // is the property that stops "monitor never enabled" from being read as
    // "zero divergence over N days".
    expect(res.body.enabled).toBe(false);
  });
});
