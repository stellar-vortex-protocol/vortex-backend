/**
 * Analytics routes added for issues #599 (token-pair) and #600 (solver benchmark).
 * Data is ingested straight into the in-memory store the app runs with.
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { ANALYTICS_STORE } from "../src/analytics/analytics.tokens";
import { IAnalyticsStore } from "../src/analytics/analytics.store";

const T = Date.UTC(2026, 0, 1, 10, 15, 0);
const range = { interval: "1h", from: Date.UTC(2026, 0, 1) / 1000, to: Date.UTC(2026, 0, 2) / 1000 };

describe("Analytics token-pair and solver-benchmark (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    const store = app.get<IAnalyticsStore>(ANALYTICS_STORE);
    const base = { timestamp: T, chain: "stellar", fees: 1n };
    await store.ingest([
      { ...base, eventId: "e2e:1", srcToken: "USDC", dstToken: "XLM", solver: "A", volume: 100n, durationMs: 100 },
      { ...base, eventId: "e2e:2", srcToken: "XLM", dstToken: "USDC", solver: "B", volume: 300n, durationMs: 500 },
      { ...base, eventId: "e2e:3", srcToken: "USDC", dstToken: "XLM", solver: "C", volume: 200n, durationMs: 300 },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/analytics/token-pair breaks volume down by exact pair", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/analytics/token-pair").query(range).expect(200);
    expect(res.body).toEqual([
      { start: "2026-01-01T10:00:00.000Z", srcToken: "USDC", dstToken: "XLM", volume: "300", fees: "2" },
      { start: "2026-01-01T10:00:00.000Z", srcToken: "XLM", dstToken: "USDC", volume: "300", fees: "1" },
    ]);
  });

  it("GET /api/v1/analytics/volume honors the solver filter", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/analytics/volume")
      .query({ ...range, solver: "B" })
      .expect(200);
    expect(res.body).toEqual([{ start: "2026-01-01T10:00:00.000Z", volume: "300" }]);
  });

  it("GET /api/v1/analytics/solver-benchmark/:address compares with the median solver", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/analytics/solver-benchmark/A")
      .query(range)
      .expect(200);
    expect(res.body).toEqual([
      {
        start: "2026-01-01T10:00:00.000Z",
        solver: { avgMs: 100, volume: "100", count: 1 },
        protocol: { medianAvgMs: 300, medianVolume: "200", solverCount: 3 },
      },
    ]);
  });

  it("returns solver: null for a solver with no fills in a bucket", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/analytics/solver-benchmark/NOBODY")
      .query(range)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].solver).toBeNull();
  });

  it("still rejects unknown metrics", async () => {
    await request(app.getHttpServer()).get("/api/v1/analytics/nope").query(range).expect(400);
  });
});
