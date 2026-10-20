import { ConfigService } from "@nestjs/config";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/configuration";
import { AccountAgeCache, AccountAgeHttp, AccountAgeService, resolveAccountId } from "./account-age.service";

const HORIZON = "https://horizon-testnet.stellar.org";
const NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0);

function config(): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => (key === "stellar.horizonUrl" ? HORIZON : "redis://localhost:6379"),
  } as unknown as ConfigService<AppConfig, true>;
}

class MemoryCache implements AccountAgeCache {
  readonly entries = new Map<string, { value: string; ttl: number }>();
  async get(key: string) {
    return this.entries.get(key)?.value ?? null;
  }
  async set(key: string, value: string, ttl: number) {
    this.entries.set(key, { value, ttl });
  }
}

type Reply = { statusCode: number; body: string } | Error | "hang";

/** Routes `/accounts/{id}` and `/accounts/{id}/effects...` to canned replies. */
function horizon(account: Reply, effects: Reply = ok({ _embedded: { records: [] } })) {
  const calls: string[] = [];
  const http: AccountAgeHttp = {
    fetch: (url: string) => {
      calls.push(url);
      const reply = url.includes("/effects") ? effects : account;
      if (reply === "hang") return new Promise(() => undefined);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
  return { http, calls };
}

function ok(body: unknown) {
  return { statusCode: 200, body: JSON.stringify(body) };
}

function createdEffect(isoTime: string) {
  return ok({ _embedded: { records: [{ type: "account_created", created_at: isoTime }] } });
}

describe("AccountAgeService", () => {
  const account = Keypair.random().publicKey();
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache();
    jest.useFakeTimers({ now: NOW_MS, doNotFake: ["nextTick", "setImmediate"] });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ABUSE_ACCOUNT_AGE_TIMEOUT_MS;
  });

  it("returns the age of an existing account from its account_created effect", async () => {
    const { http, calls } = horizon(ok({ id: account }), createdEffect("2026-10-20T11:00:00Z"));
    const svc = new AccountAgeService(config(), http, cache);

    await expect(svc.getAccountAgeSeconds(account)).resolves.toBe(3600);
    expect(calls).toEqual([
      `${HORIZON}/accounts/${account}`,
      `${HORIZON}/accounts/${account}/effects?order=asc&limit=1`,
    ]);
  });

  it("caches the creation time and serves later lookups without Horizon", async () => {
    const { http, calls } = horizon(ok({ id: account }), createdEffect("2026-10-20T11:00:00Z"));
    const svc = new AccountAgeService(config(), http, cache);

    await svc.getAccountAgeSeconds(account);
    expect(cache.entries.get(`vortex:abuse:account-created:${account}`)).toEqual({
      value: String(Date.UTC(2026, 9, 20, 11) / 1000),
      ttl: 3600,
    });

    // Age keeps growing from the cached creation time.
    jest.setSystemTime(NOW_MS + 60_000);
    await expect(svc.getAccountAgeSeconds(account)).resolves.toBe(3660);
    expect(calls).toHaveLength(2);
  });

  it("treats an account that does not exist yet as brand new (age 0), not an error", async () => {
    const { http } = horizon({ statusCode: 404, body: "{}" }, { statusCode: 404, body: "{}" });
    const svc = new AccountAgeService(config(), http, cache);

    await expect(svc.getAccountAgeSeconds(account)).resolves.toBe(0);
    expect(cache.entries.get(`vortex:abuse:account-created:${account}`)).toEqual({ value: "none", ttl: 60 });
  });

  it("returns undefined when Horizon errors", async () => {
    const { http } = horizon({ statusCode: 503, body: "" });
    const svc = new AccountAgeService(config(), http, cache);
    await expect(svc.getAccountAgeSeconds(account)).resolves.toBeUndefined();
    expect(cache.entries.size).toBe(0);
  });

  it("returns undefined when the request is rejected (network error)", async () => {
    const { http } = horizon(new Error("ECONNRESET"));
    const svc = new AccountAgeService(config(), http, cache);
    await expect(svc.getAccountAgeSeconds(account)).resolves.toBeUndefined();
  });

  it("returns undefined when Horizon does not answer within the timeout", async () => {
    process.env.ABUSE_ACCOUNT_AGE_TIMEOUT_MS = "50";
    const { http } = horizon("hang", "hang");
    const svc = new AccountAgeService(config(), http, cache);

    const pending = svc.getAccountAgeSeconds(account);
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeUndefined();
  });

  it("uses the oldest remaining effect as a lower bound when history was pruned", async () => {
    const { http } = horizon(
      ok({ id: account }),
      ok({ _embedded: { records: [{ type: "account_credited", created_at: "2025-10-20T12:00:00Z" }] } }),
    );
    const svc = new AccountAgeService(config(), http, cache);
    await expect(svc.getAccountAgeSeconds(account)).resolves.toBe(365 * 86_400);
  });

  it("returns undefined for an existing account with no effects at all", async () => {
    const { http } = horizon(ok({ id: account }));
    const svc = new AccountAgeService(config(), http, cache);
    await expect(svc.getAccountAgeSeconds(account)).resolves.toBeUndefined();
  });

  it("looks up the base G... account for a muxed M... address", async () => {
    const muxed = new MuxedAccount(new Account(account, "0"), "7").accountId();
    const { http, calls } = horizon(ok({ id: account }), createdEffect("2026-10-20T11:59:00Z"));
    const svc = new AccountAgeService(config(), http, cache);

    await expect(svc.getAccountAgeSeconds(muxed)).resolves.toBe(60);
    expect(calls[0]).toBe(`${HORIZON}/accounts/${account}`);
  });

  it("skips the lookup for non-Stellar addresses", async () => {
    const { http, calls } = horizon(ok({}));
    const svc = new AccountAgeService(config(), http, cache);
    await expect(svc.getAccountAgeSeconds("0x52908400098527886E0F7030069857D2E4169EE7")).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("still looks up when the cache itself fails", async () => {
    const broken: AccountAgeCache = {
      get: () => Promise.reject(new Error("redis down")),
      set: () => Promise.reject(new Error("redis down")),
    };
    const { http } = horizon(ok({ id: account }), createdEffect("2026-10-20T11:00:00Z"));
    const svc = new AccountAgeService(config(), http, broken);
    await expect(svc.getAccountAgeSeconds(account)).resolves.toBe(3600);
  });
});

describe("resolveAccountId", () => {
  it("accepts G... addresses in any case and rejects garbage", () => {
    const g = Keypair.random().publicKey();
    expect(resolveAccountId(g)).toBe(g);
    expect(resolveAccountId(g.toLowerCase())).toBe(g);
    expect(resolveAccountId("not-an-address")).toBeUndefined();
  });
});
