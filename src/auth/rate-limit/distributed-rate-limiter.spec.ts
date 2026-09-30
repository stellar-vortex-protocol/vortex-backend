import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { DistributedRateLimiter, RATE_LIMIT_REDIS } from "./distributed-rate-limiter";
import { LocalRateLimitStore } from "./local-rate-limit.store";
import { RedisRateLimitStore } from "./redis-rate-limit.store";
import type { RateLimitRedis } from "./rate-limit-result";

/**
 * In-memory stand-in for the Redis commands the sliding-window Lua script
 * issues. It deliberately mirrors the script's algorithm — evict, count, then
 * conditionally add — so a test that passes here is exercising the same
 * semantics the real script implements, including the same-millisecond
 * uniqueness via a companion counter.
 *
 * One instance models one Redis *server*; two limiters sharing one instance
 * model two application replicas talking to the same Redis.
 */
class FakeRedis implements RateLimitRedis {
  /** key -> sorted set of members scored by request timestamp. */
  readonly zsets = new Map<string, Map<string, number>>();
  /** key -> monotonic counter backing member uniqueness. */
  readonly counters = new Map<string, number>();

  /** Set to make every `eval` reject, simulating a Redis outage. */
  failWith: Error | null = null;

  eval(_script: string, numKeys: number, ...args: (string | number)[]): Promise<[number, number, number]> {
    if (this.failWith) return Promise.reject(this.failWith);
    const key = String(args[0]);
    const window = Number(args[1]);
    const limit = Number(args[2]);
    const now = Number(args[3]);
    void numKeys;

    const zset = this.zsets.get(key) ?? new Map<string, number>();

    // ZREMRANGEBYSCORE key 0 now-window
    for (const [member, score] of zset) {
      if (score <= now - window) zset.delete(member);
    }

    if (zset.size < limit) {
      const counter = (this.counters.get(`${key}:m`) ?? 0) + 1;
      this.counters.set(`${key}:m`, counter);
      zset.set(`${now}-${counter}`, now);
      this.zsets.set(key, zset);
      // Lua returns `limit - count - 1` where `count` is the pre-insert size.
      return Promise.resolve([1, limit - zset.size, now + window]);
    }

    // Denied: reset when the oldest in-window member falls out of the window.
    const oldest = Math.min(...zset.values());
    this.zsets.set(key, zset);
    return Promise.resolve([0, 0, oldest + window]);
  }
}

function config(pruneMs = 60_000): ConfigService<AppConfig, true> {
  return {
    get: (key: keyof AppConfig) => (key === "rateLimitLocalPruneMs" ? pruneMs : undefined),
  } as unknown as ConfigService<AppConfig, true>;
}

const WINDOW = 60_000;

describe("DistributedRateLimiter (#441)", () => {
  describe("shared quota across replicas", () => {
    it("gives N replicas one global quota, not N x limit", async () => {
      // Both limiters talk to the SAME Redis, so they are two replicas of the
      // same deployment — the situation the issue is about.
      const redis = new FakeRedis();
      const replicaA = new DistributedRateLimiter(redis, config());
      const replicaB = new DistributedRateLimiter(redis, config());

      const limit = 5;
      // Interleave requests across the replicas. If the window were per-process
      // this would allow 2 x limit; the shared window must allow exactly `limit`.
      const results = [];
      for (let i = 0; i < limit; i++) {
        results.push(await replicaA.consume("apiKey:abc12345", limit, WINDOW, 1_000));
        results.push(await replicaB.consume("apiKey:abc12345", limit, WINDOW, 1_000));
      }

      expect(results.filter((r) => r?.allowed)).toHaveLength(limit);
      // Every denial comes back with remaining 0, proving both replicas see the
      // same counter rather than independent ones.
      const denials = results.filter((r) => !r?.allowed);
      expect(denials).toHaveLength(limit);
      for (const denial of denials) expect(denial?.remaining).toBe(0);
    });

    it("keeps separate buckets for separate keys", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());

      for (let i = 0; i < 3; i++) {
        expect((await limiter.consume("apiKey:one", 3, WINDOW, 1_000))?.allowed).toBe(true);
      }
      // The `one` bucket is exhausted...
      expect((await limiter.consume("apiKey:one", 3, WINDOW, 1_000))?.allowed).toBe(false);
      // ...but an unrelated key is unaffected.
      expect((await limiter.consume("apiKey:two", 3, WINDOW, 1_000))?.allowed).toBe(true);
    });

    it("reports remaining and a reset time consistent with the window", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());

      const first = await limiter.consume("ip:1.2.3.4", 3, WINDOW, 1_000);
      expect(first).toEqual({ allowed: true, limit: 3, remaining: 2, resetAt: 1_000 + WINDOW });

      const second = await limiter.consume("ip:1.2.3.4", 3, WINDOW, 2_000);
      expect(second?.remaining).toBe(1);
    });
  });

  describe("sliding window behaviour", () => {
    it("frees capacity as the window slides past old entries", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());

      expect((await limiter.consume("k", 2, WINDOW, 1_000))?.allowed).toBe(true);
      expect((await limiter.consume("k", 2, WINDOW, 1_100))?.allowed).toBe(true);
      expect((await limiter.consume("k", 2, WINDOW, 1_200))?.allowed).toBe(false);

      // The entries at t=1000/1100 age out at t=61000/61100.
      expect((await limiter.consume("k", 2, WINDOW, 61_100))?.allowed).toBe(true);
    });

    it("counts distinct members for requests inside the same millisecond", async () => {
      // The Lua script appends a companion counter to the member so two
      // requests in one millisecond do not collapse into a single zset entry
      // and silently grant extra capacity.
      const redis = new FakeRedis();
      const store = new RedisRateLimitStore(redis);

      await store.consume("k", WINDOW, 2, 5_000);
      await store.consume("k", WINDOW, 2, 5_000);
      const third = await store.consume("k", WINDOW, 2, 5_000);

      expect(third.allowed).toBe(false);
    });

    it("resets the window at the oldest entry when denying", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());

      await limiter.consume("k", 1, WINDOW, 10_000);
      const denied = await limiter.consume("k", 1, WINDOW, 20_000);

      expect(denied?.allowed).toBe(false);
      expect(denied?.resetAt).toBe(10_000 + WINDOW);
    });
  });

  describe("Redis outage fallback", () => {
    it("falls back to a bounded local window instead of failing open", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());

      // A request on the healthy path goes to Redis and leaves the local
      // fallback's window empty. Once Redis is gone the limiter counts from its
      // own window, so the outage trades global accuracy for a still-enforced
      // per-process bound — the documented behaviour, and the reason the
      // fallback is bounded rather than permissive.
      expect((await limiter.consume("k", 2, WINDOW, 1_000))?.allowed).toBe(true);

      redis.failWith = new Error("ECONNREFUSED 127.0.0.1:6379");

      expect((await limiter.consume("k", 2, WINDOW, 1_100))?.allowed).toBe(true);
      expect((await limiter.consume("k", 2, WINDOW, 1_200))?.allowed).toBe(true);

      // The third request inside the fallback window is denied. Crucially it is
      // DENIED rather than allowed: a Redis outage must never mean unlimited.
      const denied = await limiter.consume("k", 2, WINDOW, 1_300);
      expect(denied?.allowed).toBe(false);
      expect(denied?.remaining).toBe(0);
    });

    it("reports the Redis path as unhealthy while the outage lasts", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());
      expect(limiter.isRedisHealthy).toBe(true);

      redis.failWith = new Error("down");
      await limiter.consume("k", 10, WINDOW, 1_000);
      expect(limiter.isRedisHealthy).toBe(false);
    });

    it("recovers to the shared window once Redis returns", async () => {
      const redis = new FakeRedis();
      const limiter = new DistributedRateLimiter(redis, config());

      redis.failWith = new Error("down");
      await limiter.consume("k", 10, WINDOW, 1_000);
      expect(limiter.isRedisHealthy).toBe(false);

      redis.failWith = null;
      await limiter.consume("k", 10, WINDOW, 1_100);
      expect(limiter.isRedisHealthy).toBe(true);
    });

    it("treats a malformed Lua reply as a failure, not as unlimited", async () => {
      const redis = {
        eval: jest.fn().mockResolvedValue("nonsense"),
      } as unknown as RateLimitRedis;
      const limiter = new DistributedRateLimiter(redis, config());

      // The store throws on a malformed tuple, which routes to the local
      // fallback — the result must still carry a real limit.
      const result = await limiter.consume("k", 3, WINDOW, 1_000);
      expect(result).not.toBeNull();
      expect(result?.limit).toBe(3);
      expect(limiter.isRedisHealthy).toBe(false);
    });

    it("enforces the limit per process with no Redis client at all", async () => {
      // RATE_LIMIT_REDIS resolves to null when no Redis URL is configured, so
      // this is the single-replica path, not an outage.
      const limiter = new DistributedRateLimiter(null, config());

      expect((await limiter.consume("k", 2, WINDOW, 1_000))?.allowed).toBe(true);
      expect((await limiter.consume("k", 2, WINDOW, 1_001))?.allowed).toBe(true);
      expect((await limiter.consume("k", 2, WINDOW, 1_002))?.allowed).toBe(false);
    });
  });

  describe("injection token", () => {
    it("exports a unique symbol so the module can override the client", () => {
      expect(typeof RATE_LIMIT_REDIS).toBe("symbol");
    });
  });
});

describe("LocalRateLimitStore (#441 fallback)", () => {
  it("bounds memory by pruning expired keys", async () => {
    const store = new LocalRateLimitStore();
    await store.consume("a", WINDOW, 10, 1_000);
    await store.consume("b", WINDOW, 10, 1_000);
    expect(store.size).toBe(2);

    // Everything is far outside the window now.
    store.prune(1_000 + WINDOW + 1, WINDOW);
    expect(store.size).toBe(0);
  });

  it("keeps keys that still have in-window entries", async () => {
    const store = new LocalRateLimitStore();
    await store.consume("a", WINDOW, 10, 1_000);
    await store.consume("a", WINDOW, 10, 5_000);

    // Prune at a time that keeps the t=5000 entry but drops t=1000.
    store.prune(5_001, WINDOW);
    expect(store.size).toBe(1);
  });
});
