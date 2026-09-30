import { ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { TieredThrottleGuard } from "./tiered-throttle.guard";
import { DistributedRateLimiter } from "./distributed-rate-limiter";
import { ApiKeyService } from "../api-keys/api-key.service";
import { TIER_LIMITS } from "../api-keys/api-key-tiers";
import type { RateLimitResult } from "./rate-limit-result";

/**
 * Minimal express request/response doubles. The guard only touches
 * `headers`, `socket.remoteAddress` and `setHeader`, so faking those keeps the
 * test focused on the tiering and header contract rather than on supertest.
 */
function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {} as Record<string, unknown>,
    socket: { remoteAddress: "10.0.0.7" },
    ...overrides,
  };
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  };
}

function makeContext(req: unknown, res: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

/** A limiter that always allows, recording the (key, limit) it was asked about. */
function allowingLimiter(): {
  limiter: DistributedRateLimiter;
  calls: { key: string; limit: number }[];
} {
  const calls: { key: string; limit: number }[] = [];
  const limiter = {
    consume: jest.fn(async (key: string, limit: number) => {
      calls.push({ key, limit });
      return { allowed: true, limit, remaining: limit - 1, resetAt: Date.now() + 60_000 } as RateLimitResult;
    }),
  } as unknown as DistributedRateLimiter;
  return { limiter, calls };
}

/** A limiter that always denies, echoing back whatever limit the guard asked for. */
function denyingLimiter(): DistributedRateLimiter {
  return {
    consume: jest.fn(async (_key: string, limit: number) => ({
      allowed: false,
      limit,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    })),
  } as unknown as DistributedRateLimiter;
}

function config(): ConfigService<AppConfig, true> {
  return {
    get: (key: keyof AppConfig) =>
      key === "ws" ? ({ trustProxyHops: 1 } as AppConfig["ws"]) : undefined,
  } as unknown as ConfigService<AppConfig, true>;
}

/** Run the guard and return the HttpException it threw, failing if it did not. */
async function expectRejection(guard: TieredThrottleGuard, ctx: ExecutionContext): Promise<HttpException> {
  try {
    const allowed = await guard.canActivate(ctx);
    throw new Error(`expected the guard to reject, but it allowed (${allowed})`);
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
}

/** An ApiKeyService stub that resolves one key prefix to a tier. */
function keysResolving(tier: string | null): ApiKeyService {
  return {
    resolveKey: jest.fn(async (plaintext: string) =>
      tier === null
        ? null
        : { id: "k1", keyPrefix: plaintext.slice(0, 8), tier, owner: "o", scopes: [], revokedAt: null, expiresAt: null },
    ),
  } as unknown as ApiKeyService;
}

describe("TieredThrottleGuard (#441)", () => {
  describe("tier selection", () => {
    it("applies the public tier per IP when no API key is presented", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving(null), config());
      const req = makeReq();
      const res = makeRes();

      await expect(guard.canActivate(makeContext(req, res))).resolves.toBe(true);

      expect(calls[0].limit).toBe(TIER_LIMITS.public.requestsPerMinute);
      expect(calls[0].key).toBe("ip:10.0.0.7");
    });

    it("never weakens the legacy anonymous limit", async () => {
      // The pre-#441 global throttle allowed 100 req/min anonymously. If the
      // public tier were lower, shipping tiered keys would throttle existing
      // anonymous clients harder; if higher, it would weaken protection.
      expect(TIER_LIMITS.public.requestsPerMinute).toBe(100);
    });

    it("applies the key's tier and tracks by credential prefix, not IP", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(
        limiter,
        keysResolving("solver"),
        config(),
      );
      const req = makeReq({ headers: { authorization: "Bearer sk_live_abcdefgh_secret" } });
      const res = makeRes();

      await guard.canActivate(makeContext(req, res));

      expect(calls[0].limit).toBe(TIER_LIMITS.solver.requestsPerMinute);
      // Tracked per credential so one noisy IP cannot exhaust another key's quota.
      expect(calls[0].key).toBe("apiKey:sk_live_");
    });

    it.each([
      ["integrator", "integrator"],
      ["solver", "solver"],
      ["partner", "partner"],
    ])("uses the %s tier quota", async (tier, expected) => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving(tier), config());

      await guard.canActivate(makeContext(makeReq({ headers: { "x-api-key": "prefix1234secret" } }), makeRes()));

      expect(calls[0].limit).toBe(TIER_LIMITS[expected as "solver"].requestsPerMinute);
    });

    it("accepts the key from the x-api-key header as well as Bearer", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving("partner"), config());

      // "prefix1234secret" — the tracker uses the first 8 characters, the
      // non-secret lookup prefix, not the whole presented key.
      await guard.canActivate(makeContext(makeReq({ headers: { "x-api-key": "prefix1234secret" } }), makeRes()));

      expect(calls[0].key).toBe("apiKey:prefix12");
    });

    it("falls back to the public tier when the presented key does not resolve", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving(null), config());
      const req = makeReq({ headers: { authorization: "Bearer revoked-key-value" } });

      await guard.canActivate(makeContext(req, makeRes()));

      // An invalid key must not be able to claim a higher tier.
      expect(calls[0].limit).toBe(TIER_LIMITS.public.requestsPerMinute);
      expect(calls[0].key).toBe("ip:10.0.0.7");
    });

    it("ignores an empty Bearer token", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving("partner"), config());

      await guard.canActivate(makeContext(makeReq({ headers: { authorization: "Bearer   " } }), makeRes()));

      expect(calls[0].key).toBe("ip:10.0.0.7");
    });
  });

  describe("client IP resolution", () => {
    it("uses the socket address when X-Forwarded-For is absent", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving(null), config());

      await guard.canActivate(makeContext(makeReq(), makeRes()));

      expect(calls[0].key).toBe("ip:10.0.0.7");
    });

    it("honours the trusted-hop count so a client cannot spoof its quota bucket", async () => {
      const { limiter, calls } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving(null), config());
      const req = makeReq({
        headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.4" },
      });

      await guard.canActivate(makeContext(req, makeRes()));

      // One trusted hop: the entry immediately before the socket address.
      expect(calls[0].key).toBe("ip:198.51.100.4");
    });
  });

  describe("response headers", () => {
    it("sets RateLimit-Limit, -Remaining and -Reset on every allowed response", async () => {
      const { limiter } = allowingLimiter();
      const guard = new TieredThrottleGuard(limiter, keysResolving("integrator"), config());
      const res = makeRes();
      const req = makeReq({ headers: { authorization: "Bearer prefix1234secret" } });

      await guard.canActivate(makeContext(req, res));

      // The advertised limit is the tier's quota, not the anonymous one.
      expect(res.headers["RateLimit-Limit"]).toBe(String(TIER_LIMITS.integrator.requestsPerMinute));
      expect(res.headers["RateLimit-Remaining"]).toBe(String(TIER_LIMITS.integrator.requestsPerMinute - 1));
      expect(Number(res.headers["RateLimit-Reset"])).toBeGreaterThan(0);
    });
  });

  describe("rejection", () => {
    it("throws 429 with Retry-After when the window is exhausted", async () => {
      const guard = new TieredThrottleGuard(denyingLimiter(), keysResolving(null), config());
      const res = makeRes();

      const error = await expectRejection(guard, makeContext(makeReq(), res));

      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(res.headers["RateLimit-Limit"]).toBe(String(TIER_LIMITS.public.requestsPerMinute));
      expect(res.headers["RateLimit-Remaining"]).toBe("0");
      expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
    });

    it("reports the standard Too Many Requests message", async () => {
      const guard = new TieredThrottleGuard(denyingLimiter(), keysResolving(null), config());

      const error = await expectRejection(guard, makeContext(makeReq(), makeRes()));

      expect(error.message).toBe("Too Many Requests");
    });

    it("rounds Retry-After up to at least one second", async () => {
      const limiter = {
        consume: jest.fn(async () => ({
          allowed: false,
          limit: 5,
          remaining: 0,
          // Reset is 1ms away; a client must still be told to wait a whole second.
          resetAt: Date.now() + 1,
        })),
      } as unknown as DistributedRateLimiter;
      const guard = new TieredThrottleGuard(limiter, keysResolving(null), config());
      const res = makeRes();

      await guard.canActivate(makeContext(makeReq(), res)).catch(() => undefined);

      expect(res.headers["Retry-After"]).toBe("1");
    });
  });

  describe("fail-closed", () => {
    it("returns 503 rather than allowing the request when the limiter fails", async () => {
      // `consume` returning null means the limiter could not produce a result it
      // is willing to stand behind. Allowing here would be a silent bypass.
      const limiter = {
        consume: jest.fn(async () => null),
      } as unknown as DistributedRateLimiter;
      const guard = new TieredThrottleGuard(limiter, keysResolving(null), config());
      const res = makeRes();

      const error = await expectRejection(guard, makeContext(makeReq(), res));

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.headers["RateLimit-Remaining"]).toBe("0");
    });
  });
});
