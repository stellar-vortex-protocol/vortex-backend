import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import configuration, { AppConfig } from "../src/config/configuration";
import { HealthController } from "../src/health/health.controller";
import { DatabaseHealthService } from "../src/health/database-health.service";
import { HealthIndicatorRegistry } from "../src/health/health-indicator.registry";
import { databaseIndicator, killSwitchIndicator, migrationsIndicator, rpcQuorumIndicator } from "../src/health/indicators";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Issue #492 — live/ready/startup probes, one scenario per dependency outage.
 * Dependencies are simulated through switchable fakes; checks are driven with
 * registry.evaluate() instead of waiting for the background interval.
 */
describe("Health probes (e2e)", () => {
  const deps = { db: true, rpc: [true, true, false], backplane: true, killswitch: true, migrations: true };
  let app: INestApplication;
  let registry: HealthIndicatorRegistry;

  const fakeFetch = (async (url: string) => {
    const i = Number(url.slice(-1));
    if (!deps.rpc[i]) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => ({ result: { status: "healthy" } }) };
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    const base = configuration();
    const values: AppConfig = {
      ...base,
      health: { ...base.health, readyFailureThreshold: 2, readySuccessThreshold: 2, checkIntervalMs: 3_600_000 },
    };
    const config = { get: (k: keyof AppConfig) => values[k] } as unknown as ConfigService<AppConfig, true>;
    const db = {
      check: async () => (deps.db ? { status: "ok", latencyMs: 1 } : { status: "unreachable", error: "ECONNREFUSED" }),
    } as unknown as DatabaseHealthService;
    const prisma = {
      $queryRaw: async () => (deps.migrations ? [{ migration_name: "20240101000000_init" }] : []),
    } as unknown as PrismaService;

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthIndicatorRegistry,
        { provide: ConfigService, useValue: config },
        { provide: DatabaseHealthService, useValue: db },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    registry = app.get(HealthIndicatorRegistry);
    registry.register(databaseIndicator(db, true));
    registry.register(migrationsIndicator(prisma, `${__dirname}/fixtures/migrations`));
    registry.register(rpcQuorumIndicator(["rpc0", "rpc1", "rpc2"], ["worker"], fakeFetch));
    registry.register(killSwitchIndicator({ isReady: () => deps.killswitch }));
    registry.register({
      name: "ws_backplane",
      criticalFor: ["ws"],
      check: async () => (deps.backplane ? { status: "up" } : { status: "down", error: "redis unreachable" }),
    });
    await app.init();
  });

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  async function evaluate(times = 1) {
    for (let i = 0; i < times; i++) await registry.evaluate();
  }

  it("is live, started and ready when dependencies are up (RPC 2-of-3 quorum)", async () => {
    await evaluate();
    await http().get("/health/live").expect(200);
    await http().get("/health/startup").expect(200);
    const ready = await http().get("/health/ready").expect(200);
    expect(ready.body.status).toBe("ok"); // one RPC endpoint down, quorum held
    expect(ready.body.indicators.soroban_rpc_quorum.details).toMatchObject({ healthy: 2, quorum: 2 });
  });

  it.each([
    ["database", () => (deps.db = false), () => (deps.db = true)],
    ["soroban_rpc_quorum", () => (deps.rpc = [true, false, false]), () => (deps.rpc = [true, true, false])],
    ["ws_backplane", () => (deps.backplane = false), () => (deps.backplane = true)],
    ["killswitch_snapshot", () => (deps.killswitch = false), () => (deps.killswitch = true)],
  ])("%s down: not ready after the failure threshold, live stays ok, recovers with hysteresis", async (name, down, up) => {
    down();
    await evaluate(1);
    await http().get("/health/ready").expect(200); // hysteresis: one failure is not enough
    await evaluate(1);
    const res = await http().get("/health/ready").expect(503);
    expect(res.body).toMatchObject({ ready: false, status: "not_ready" });
    expect(res.body.indicators[name]).toMatchObject({ status: "down", critical: true });
    await http().get("/health/live").expect(200);

    up();
    await evaluate(1);
    await http().get("/health/ready").expect(503);
    await evaluate(1);
    await http().get("/health/ready").expect(200);
  });

  it("legacy /health keeps its shape and reports the backplane", async () => {
    const res = await http().get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", service: "vortex-backend", db: { status: "ok" } });
    expect(res.body.backplane).toMatchObject({ status: "up" });
  });

  it("probe responses are served from cache in under 50 ms", async () => {
    const started = Date.now();
    await http().get("/health/ready");
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("startup fails until migrations are applied", async () => {
    const fresh = new HealthIndicatorRegistry();
    fresh.register(migrationsIndicator({ $queryRaw: async () => [] } as unknown as PrismaService, `${__dirname}/fixtures/migrations`));
    await fresh.evaluate();
    expect(fresh.startup()).toMatchObject({ started: false, pending: [expect.objectContaining({ name: "migrations" })] });
    fresh.onModuleDestroy();
  });

  it("liveness fails when the event loop is blocked", async () => {
    const blocked = Date.now();
    while (Date.now() - blocked < 1_200) {
      /* block the loop past HEALTH_EVENT_LOOP_MAX_LAG_MS (1000) */
    }
    await new Promise((r) => setTimeout(r, 50));
    const res = await http().get("/health/live");
    expect(res.body).toMatchObject({ status: "unresponsive" });
    expect(res.status).toBe(503);
  });
});
