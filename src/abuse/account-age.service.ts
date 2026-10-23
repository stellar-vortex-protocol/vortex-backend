/**
 * AccountAgeService — how long ago a Stellar account was created, for the
 * `new_address` abuse rule.
 *
 * Lookup order
 * ────────────
 * 1. Redis cache (`vortex:abuse:account-created:<G...>`). The cached value is
 *    the creation time, not the age, so a cached entry stays correct as time
 *    passes.
 * 2. Horizon, on a cache miss: `GET /accounts/{id}` (does it exist?) and
 *    `GET /accounts/{id}/effects?order=asc&limit=1` (its first effect is
 *    `account_created`, which carries the creation time). Both requests run in
 *    parallel and the pair is bounded by a short timeout.
 *
 * Outcomes
 * ────────
 * - Account found → age in seconds; cached for `ABUSE_ACCOUNT_AGE_CACHE_TTL_SECONDS`.
 * - Account not on-chain yet (Horizon 404) → age 0. Such an address is as new
 *   as it gets, not an error. Cached briefly so a burst of requests from the
 *   same unfunded address costs one lookup.
 * - Anything else (timeout, Horizon 5xx, non-Stellar address) → `undefined`,
 *   which makes `new_address` stay silent exactly as before this lookup
 *   existed. An RPC outage never blocks or penalises a request.
 *
 * Muxed (`M...`) addresses are resolved to their underlying `G...` account.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StrKey } from "@stellar/stellar-sdk";
import Redis from "ioredis";
import { EgressPurpose, HttpEgressService } from "../common/http-egress";
import { AppConfig } from "../config/configuration";

/** Redis key prefix for cached account creation times. */
const CACHE_PREFIX = "vortex:abuse:account-created";

/** Marker cached for accounts that do not exist on-chain yet. */
const NOT_FOUND = "none";

/** How long a "not found" result is cached (seconds). */
const NOT_FOUND_TTL_SECONDS = 60;

/** Injection token for the Horizon HTTP client (tests pass a stub). */
export const ACCOUNT_AGE_HTTP = Symbol("ACCOUNT_AGE_HTTP");
/** Injection token for the cache (tests pass an in-memory stub). */
export const ACCOUNT_AGE_CACHE = Symbol("ACCOUNT_AGE_CACHE");

/** The subset of {@link HttpEgressService} this service uses. */
export interface AccountAgeHttp {
  fetch(url: string, options?: { purpose?: EgressPurpose }): Promise<{ statusCode: number; body: string }>;
}

/** Minimal key/value cache with per-key TTL. */
export interface AccountAgeCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

type CreationLookup =
  | { kind: "created"; createdAt: number }
  | { kind: "missing" }
  | { kind: "unknown" };

class RedisAccountAgeCache implements AccountAgeCache {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }
}

@Injectable()
export class AccountAgeService implements OnModuleDestroy {
  private readonly logger = new Logger(AccountAgeService.name);
  private readonly horizonBase: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlSeconds: number;
  private readonly http: AccountAgeHttp;
  private readonly cache: AccountAgeCache;
  private readonly redis?: Redis;

  constructor(
    config: ConfigService<AppConfig, true>,
    @Optional() @Inject(ACCOUNT_AGE_HTTP) http?: AccountAgeHttp,
    @Optional() @Inject(ACCOUNT_AGE_CACHE) cache?: AccountAgeCache,
  ) {
    const horizonUrl = config.get("stellar.horizonUrl", { infer: true });
    this.horizonBase = horizonUrl.replace(/\/$/, "");
    this.timeoutMs = positiveInt(process.env.ABUSE_ACCOUNT_AGE_TIMEOUT_MS, 1_500);
    this.cacheTtlSeconds = positiveInt(process.env.ABUSE_ACCOUNT_AGE_CACHE_TTL_SECONDS, 3_600);

    this.http =
      http ??
      new HttpEgressService({
        timeoutMs: this.timeoutMs,
        maxRedirects: 0,
        maxBodySizeBytes: 262_144,
        allowlist: [new URL(horizonUrl).hostname],
        blockPrivateRanges: false,
      });

    if (cache) {
      this.cache = cache;
    } else {
      this.redis = new Redis(config.get("redisUrl", { infer: true }), {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      this.redis.on("error", (err: Error) =>
        this.logger.debug(`[account-age] Redis error — cache bypassed: ${err.message}`),
      );
      this.cache = new RedisAccountAgeCache(this.redis);
    }
  }

  /**
   * Age of the account behind `address` in seconds, `0` if it does not exist
   * on-chain yet, or `undefined` if it cannot be determined. Never throws.
   */
  async getAccountAgeSeconds(address: string): Promise<number | undefined> {
    const accountId = resolveAccountId(address);
    if (!accountId) return undefined;

    const now = Math.floor(Date.now() / 1000);
    const key = `${CACHE_PREFIX}:${accountId}`;

    const cached = await this.cache.get(key).catch(() => null);
    if (cached === NOT_FOUND) return 0;
    if (cached !== null && Number.isFinite(Number(cached))) {
      return Math.max(0, now - Number(cached));
    }

    let result: CreationLookup;
    try {
      result = await withTimeout(this.lookupCreation(accountId), this.timeoutMs);
    } catch (err) {
      this.logger.debug(`[account-age] lookup failed for ${accountId}: ${(err as Error).message}`);
      return undefined;
    }

    if (result.kind === "missing") {
      void this.cache.set(key, NOT_FOUND, NOT_FOUND_TTL_SECONDS).catch(() => undefined);
      return 0;
    }
    if (result.kind === "created") {
      void this.cache.set(key, String(result.createdAt), this.cacheTtlSeconds).catch(() => undefined);
      return Math.max(0, now - result.createdAt);
    }
    return undefined;
  }

  private async lookupCreation(accountId: string): Promise<CreationLookup> {
    const base = `${this.horizonBase}/accounts/${encodeURIComponent(accountId)}`;
    const [account, effects] = await Promise.all([
      this.http.fetch(base, { purpose: EgressPurpose.HORIZON }),
      this.http.fetch(`${base}/effects?order=asc&limit=1`, { purpose: EgressPurpose.HORIZON }),
    ]);

    if (account.statusCode === 404) return { kind: "missing" };
    if (account.statusCode < 200 || account.statusCode >= 300) {
      throw new Error(`Horizon /accounts returned ${account.statusCode}`);
    }
    if (effects.statusCode < 200 || effects.statusCode >= 300) {
      throw new Error(`Horizon /effects returned ${effects.statusCode}`);
    }

    const body = JSON.parse(effects.body) as {
      _embedded?: { records?: Array<{ type?: string; created_at?: string }> };
    };
    const first = body._embedded?.records?.[0];
    const createdAt = first?.created_at ? Date.parse(first.created_at) : NaN;
    if (!Number.isFinite(createdAt)) return { kind: "unknown" };

    // When Horizon's history retention has pruned the `account_created`
    // effect, the oldest remaining effect is still an upper bound on the
    // creation time, so the age we report is a lower bound. That is safe for
    // `new_address`: an account older than the retention window is old.
    return { kind: "created", createdAt: Math.floor(createdAt / 1000) };
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}

/**
 * The `G...` account id for a Stellar address, resolving muxed `M...`
 * addresses to their base account. Returns `undefined` for anything that is
 * not a Stellar account address (e.g. an EVM user).
 */
export function resolveAccountId(address: string): string | undefined {
  if (typeof address !== "string") return undefined;
  const upper = address.trim().toUpperCase();
  if (StrKey.isValidEd25519PublicKey(upper)) return upper;
  if (StrKey.isValidMed25519PublicKey(upper)) {
    const raw = StrKey.decodeMed25519PublicKey(upper);
    return StrKey.encodeEd25519PublicKey(raw.subarray(0, 32));
  }
  return undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
