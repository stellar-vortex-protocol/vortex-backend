import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { AppConfig } from "../config/configuration";
import { AbuseScoreService } from "./abuse-score.service";
import {
  ABUSE_RULES_REDIS_KEY,
  AbuseRuleValidationError,
  AbuseRuleOverrides,
  AbuseRulesStore,
  InMemoryAbuseRulesStore,
  RedisAbuseRulesStore,
  mergeRules,
  sanitizeOverrides,
  validateRulePatch,
} from "./abuse-rules";
import { DEFAULT_ABUSE_RULES } from "./abuse.types";

function config(): ConfigService<AppConfig, true> {
  return { get: () => "redis://localhost:6379" } as unknown as ConfigService<AppConfig, true>;
}

function scorer(store: AbuseRulesStore): AbuseScoreService {
  return new AbuseScoreService(config(), store);
}

describe("validateRulePatch", () => {
  it("accepts known fields with valid types", () => {
    expect(validateRulePatch("dust_intent", { enabled: false, weight: 0, maxDustUsd: 0.5 })).toEqual({
      enabled: false,
      weight: 0,
      maxDustUsd: 0.5,
    });
  });

  it.each([
    ["a non-object body", "nope", /JSON object/],
    ["an array body", [1], /JSON object/],
    ["an empty body", {}, /at least one/],
    ["an unknown field", { maxCycles: 3 }, /unknown field "maxCycles"/],
    ["a non-boolean enabled", { enabled: "false" }, /"enabled" must be a boolean/],
    ["a negative weight", { weight: -1 }, /"weight" must be a non-negative number/],
    ["a string window", { windowSeconds: "60" }, /"windowSeconds" must be a non-negative number/],
    ["a non-finite threshold", { maxDustUsd: Infinity }, /"maxDustUsd" must be a non-negative number/],
  ])("rejects %s", (_label, body, message) => {
    expect(() => validateRulePatch("dust_intent", body)).toThrow(message);
  });

  it("rejects a cancel ratio above 1", () => {
    expect(() => validateRulePatch("create_cancel_ratio", { minCancelRatio: 1.5 })).toThrow(/between 0 and 1/);
  });

  it("reports every problem at once", () => {
    try {
      validateRulePatch("dust_intent", { weight: -1, enabled: 1 });
      fail("expected validation error");
    } catch (err) {
      expect((err as AbuseRuleValidationError).problems).toHaveLength(2);
    }
  });
});

describe("sanitizeOverrides", () => {
  it("drops unknown rules, unknown fields, and badly typed values", () => {
    expect(
      sanitizeOverrides({
        dust_intent: { weight: 5, enabled: "yes", bogus: 1 },
        not_a_rule: { weight: 1 },
        solver_spam: "garbage",
      }),
    ).toEqual({ dust_intent: { weight: 5 } });
    expect(sanitizeOverrides("garbage")).toEqual({});
  });
});

describe("rule precedence (persisted > env > default)", () => {
  afterEach(() => {
    delete process.env.ABUSE_DUST_INTENT_WEIGHT;
    delete process.env.ABUSE_DUST_INTENT_MAX_USD;
  });

  it("mergeRules layers overrides on a copy without mutating the base", () => {
    const merged = mergeRules(DEFAULT_ABUSE_RULES, { dust_intent: { weight: 1 } });
    expect(merged.dust_intent.weight).toBe(1);
    expect(DEFAULT_ABUSE_RULES.dust_intent.weight).toBe(20);
  });

  it("persisted overrides beat env, env beats defaults, untouched fields fall through", async () => {
    process.env.ABUSE_DUST_INTENT_WEIGHT = "33";
    process.env.ABUSE_DUST_INTENT_MAX_USD = "0.05";
    const store = new InMemoryAbuseRulesStore();
    await store.update(() => ({ dust_intent: { weight: 7 } }));

    const svc = scorer(store);
    expect(svc.getRules().dust_intent).toMatchObject({ weight: 33, maxDustUsd: 0.05 }); // env, before hydrate
    await svc.onModuleInit();
    expect(svc.getRules().dust_intent).toMatchObject({
      weight: 7, // persisted
      maxDustUsd: 0.05, // env
      windowSeconds: DEFAULT_ABUSE_RULES.dust_intent.windowSeconds, // default
    });
  });

  it("resetRule drops persisted overrides and reverts to env/defaults", async () => {
    process.env.ABUSE_DUST_INTENT_WEIGHT = "33";
    const svc = scorer(new InMemoryAbuseRulesStore());
    await svc.updateRule("dust_intent", { weight: 1 });
    const change = await svc.resetRule("dust_intent");
    expect(change.before.weight).toBe(1);
    expect(change.after.weight).toBe(33);
  });
});

describe("AbuseScoreService rule updates", () => {
  it("applies an update immediately and reports before/after", async () => {
    const svc = scorer(new InMemoryAbuseRulesStore());
    const change = await svc.updateRule("ip_asn_cluster", { minAddressesPerIp: 2 });
    expect(change.before.minAddressesPerIp).toBe(5);
    expect(change.after.minAddressesPerIp).toBe(2);
    expect(svc.getRules().ip_asn_cluster.minAddressesPerIp).toBe(2);
  });

  it("does not interleave concurrent updates (each sees the previous one)", async () => {
    const store = new InMemoryAbuseRulesStore();
    const svc = scorer(store);
    await Promise.all([
      svc.updateRule("dust_intent", { weight: 1 }),
      svc.updateRule("dust_intent", { maxDustUsd: 2 }),
      svc.updateRule("solver_spam", { enabled: false }),
    ]);
    await expect(store.load()).resolves.toEqual({
      dust_intent: { weight: 1, maxDustUsd: 2 },
      solver_spam: { enabled: false },
    });
  });

  it("leaves rules untouched when the store cannot persist", async () => {
    const failing: AbuseRulesStore = {
      load: async () => ({}),
      update: () => Promise.reject(new Error("redis down")),
    };
    const svc = scorer(failing);
    await expect(svc.updateRule("dust_intent", { weight: 1 })).rejects.toThrow("redis down");
    expect(svc.getRules().dust_intent.weight).toBe(20);
  });

  it("keeps the current rules when loading overrides fails", async () => {
    const failing: AbuseRulesStore = {
      load: () => Promise.reject(new Error("redis down")),
      update: () => Promise.reject(new Error("redis down")),
    };
    const svc = scorer(failing);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.getRules()).toEqual(DEFAULT_ABUSE_RULES);
  });

  it("picks up a change written by another instance on the next refresh", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      const shared = new InMemoryAbuseRulesStore();
      const a = scorer(shared);
      const b = scorer(shared);
      await b.onModuleInit();

      await a.updateRule("burst_identical", { maxCount: 9 });
      expect(b.getRules().burst_identical.maxCount).toBe(3); // not yet refreshed

      jest.advanceTimersByTime(5_000);
      // score() refreshes first; its own Redis calls fail open in this harness.
      (b as unknown as { redis: { zcount: () => never } }).redis = {
        zcount: () => {
          throw new Error("no redis");
        },
      } as never;
      await b.score(
        { userAddress: "u", clientIp: "1.1.1.1", srcAmount: "1", intentFingerprint: "f", operation: "create" },
        false,
      );
      expect(b.getRules().burst_identical.maxCount).toBe(9);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("RedisAbuseRulesStore", () => {
  /** Fake with WATCH semantics: exec() returns null if the key was written after watch(). */
  class WatchingRedis {
    status = "ready";
    value: string | null = null;
    private version = 0;
    private watched: number | null = null;
    /** Simulate another writer landing between GET and EXEC this many times. */
    interferences = 0;

    async watch() {
      this.watched = this.version;
    }
    async unwatch() {
      this.watched = null;
    }
    async get() {
      return this.value;
    }
    multi() {
      const ops: string[] = [];
      const tx = {
        set: (_key: string, v: string) => {
          ops.push(v);
          return tx;
        },
        exec: async () => this.commit(ops[ops.length - 1]),
      };
      return tx;
    }
    private commit(next: string) {
      if (this.interferences > 0) {
        this.interferences--;
        this.version++;
      }
      const conflicted = this.watched !== this.version;
      this.watched = null;
      if (conflicted) return null;
      this.value = next;
      this.version++;
      return [[null, "OK"]];
    }
  }

  function storeWith(redis: WatchingRedis, attempts?: number) {
    return new RedisAbuseRulesStore(redis as unknown as Redis, attempts);
  }

  it("round-trips overrides through the fixed key", async () => {
    const redis = new WatchingRedis();
    const store = storeWith(redis);
    await store.update(() => ({ dust_intent: { weight: 3 } }));
    expect(JSON.parse(redis.value!)).toEqual({ dust_intent: { weight: 3 } });
    await expect(store.load()).resolves.toEqual({ dust_intent: { weight: 3 } });
    expect(ABUSE_RULES_REDIS_KEY).toBe("vortex:abuse:config");
  });

  it("retries when another writer changed the key between read and write", async () => {
    const redis = new WatchingRedis();
    redis.interferences = 2;
    const seen: AbuseRuleOverrides[] = [];
    await storeWith(redis).update((current) => {
      seen.push(current);
      return { solver_spam: { maxCycles: 4 } };
    });
    expect(seen).toHaveLength(3);
    expect(JSON.parse(redis.value!)).toEqual({ solver_spam: { maxCycles: 4 } });
  });

  it("gives up after the configured number of conflicting attempts", async () => {
    const redis = new WatchingRedis();
    redis.interferences = 10;
    await expect(storeWith(redis, 3).update(() => ({}))).rejects.toThrow(/conflicted/);
    expect(redis.value).toBeNull();
  });

  it("treats a corrupt blob as no overrides", async () => {
    const redis = new WatchingRedis();
    redis.value = "{not json";
    await expect(storeWith(redis).load()).resolves.toEqual({});
  });
});
