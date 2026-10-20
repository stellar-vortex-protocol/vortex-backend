/**
 * Runtime abuse-rule tuning API (issue #603).
 *
 * The Redis-backed rules store is swapped for the in-memory one so the suite
 * needs no Redis; the store contract (atomic read-modify-write, sparse
 * overrides) is the same and is unit-tested for Redis in abuse-rules.spec.ts.
 */
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./utils/create-test-app";
import { ABUSE_RULES_STORE, InMemoryAbuseRulesStore } from "../src/abuse/abuse-rules";
import { AbuseScoreService } from "../src/abuse/abuse-score.service";

const ADMIN_KEY = "e2e-abuse-admin-key";

describe("Abuse rules admin API (e2e)", () => {
  let app: INestApplication;
  let store: InMemoryAbuseRulesStore;
  let previousToken: string | undefined;

  beforeAll(async () => {
    previousToken = process.env.KILLSWITCH_OPERATOR_TOKEN;
    process.env.KILLSWITCH_OPERATOR_TOKEN = ADMIN_KEY;
    store = new InMemoryAbuseRulesStore();
    app = await createTestApp((builder) => builder.overrideProvider(ABUSE_RULES_STORE).useValue(store));
  });

  afterAll(async () => {
    await app.close();
    if (previousToken === undefined) delete process.env.KILLSWITCH_OPERATOR_TOKEN;
    else process.env.KILLSWITCH_OPERATOR_TOKEN = previousToken;
  });

  const server = () => app.getHttpServer();

  it("requires the admin key", async () => {
    await request(server()).get("/api/v1/abuse/rules").expect(403);
    await request(server()).get("/api/v1/abuse/rules").set("X-Admin-Key", "wrong").expect(403);
    await request(server()).patch("/api/v1/abuse/rules/dust_intent").send({ weight: 1 }).expect(403);
  });

  it("GET returns all six rules with their defaults", async () => {
    const res = await request(server()).get("/api/v1/abuse/rules").set("X-Admin-Key", ADMIN_KEY).expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "burst_identical",
      "create_cancel_ratio",
      "dust_intent",
      "ip_asn_cluster",
      "new_address",
      "solver_spam",
    ]);
    expect(res.body.dust_intent).toEqual({ enabled: true, weight: 20, windowSeconds: 60, maxDustUsd: 0.01 });
  });

  it("PATCH round-trips, persists, and takes effect without a restart", async () => {
    const res = await request(server())
      .patch("/api/v1/abuse/rules/dust_intent")
      .set("X-Admin-Key", ADMIN_KEY)
      .send({ maxDustUsd: 5, weight: 25 })
      .expect(200);
    expect(res.body.before).toMatchObject({ maxDustUsd: 0.01, weight: 20 });
    expect(res.body.after).toMatchObject({ maxDustUsd: 5, weight: 25, enabled: true });

    const get = await request(server()).get("/api/v1/abuse/rules").set("X-Admin-Key", ADMIN_KEY).expect(200);
    expect(get.body.dust_intent).toMatchObject({ maxDustUsd: 5, weight: 25 });
    await expect(store.load()).resolves.toEqual({ dust_intent: { maxDustUsd: 5, weight: 25 } });

    // The running scorer uses the new threshold on its very next evaluation:
    // a $1 intent is not dust by default but is under the new $5 threshold.
    const scorer = app.get(AbuseScoreService);
    const signal = await (scorer as unknown as {
      evalDustIntent(ctx: unknown): { signal: string; weight: number } | null;
    }).evalDustIntent({ srcAmount: "1000000", srcTokenPriceUsd: 1, srcTokenDecimals: 6 });
    expect(signal).toMatchObject({ signal: "dust_intent", weight: 25 });
  });

  it("DELETE resets a rule to its env/default configuration", async () => {
    const res = await request(server())
      .delete("/api/v1/abuse/rules/dust_intent")
      .set("X-Admin-Key", ADMIN_KEY)
      .expect(200);
    expect(res.body.after).toEqual({ enabled: true, weight: 20, windowSeconds: 60, maxDustUsd: 0.01 });
    await expect(store.load()).resolves.toEqual({});
  });

  it("returns 404 for an unknown rule", async () => {
    await request(server())
      .patch("/api/v1/abuse/rules/not_a_rule")
      .set("X-Admin-Key", ADMIN_KEY)
      .send({ weight: 1 })
      .expect(404);
  });

  it.each([
    ["a negative weight", { weight: -5 }],
    ["a string number", { windowSeconds: "60" }],
    ["a non-boolean enabled", { enabled: "false" }],
    ["a field from another rule", { maxCycles: 3 }],
    ["an empty body", {}],
  ])("rejects %s with 400 and leaves the config untouched", async (_label, body) => {
    const res = await request(server())
      .patch("/api/v1/abuse/rules/dust_intent")
      .set("X-Admin-Key", ADMIN_KEY)
      .send(body)
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/must|unknown field|at least one/);

    const get = await request(server()).get("/api/v1/abuse/rules").set("X-Admin-Key", ADMIN_KEY).expect(200);
    expect(get.body.dust_intent).toEqual({ enabled: true, weight: 20, windowSeconds: 60, maxDustUsd: 0.01 });
  });
});
