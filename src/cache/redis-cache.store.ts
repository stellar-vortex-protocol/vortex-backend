import Redis from "ioredis";
import { CACHE_KEY_VERSION, CacheKeyspace, CacheStore } from "./cache.types";

/**
 * The subset of an ioredis client the store uses. Structural so tests can
 * hand in a fake (including one that simulates an outage).
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", ttlMs: number): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  pexpire(key: string, ttlMs: number): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  del(...keys: string[]): Promise<unknown>;
  disconnect(): void;
}

/**
 * Index-set TTL. Each keyspace's index outlives its longest member so a
 * later invalidation can still find every key it must delete.
 */
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Redis-backed cache store (issue #414), shared by every replica.
 *
 * Keys of a keyspace are tracked in a Redis set (`v1:__index:<keyspace>`) so
 * invalidation is `SMEMBERS` + `DEL` rather than a `SCAN` over the whole
 * keyspace. The client is created with a short command timeout and without
 * an offline queue: during an outage commands fail fast and
 * {@link CacheService} falls through to the database instead of stalling the
 * request behind a reconnect.
 */
export class RedisCacheStore implements CacheStore {
  readonly kind = "redis" as const;

  constructor(private readonly client: RedisCacheClient) {}

  /** Build a store over a real ioredis connection. */
  static connect(redisUrl: string): RedisCacheStore {
    const client = new Redis(redisUrl, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 250,
      // Keep reconnecting in the background; reads degrade to the DB meanwhile.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // An unhandled 'error' event would crash the process; the outage is
    // already surfaced through the cache error metric.
    client.on("error", () => undefined);
    return new RedisCacheStore(client as unknown as RedisCacheClient);
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, keyspace: CacheKeyspace, value: string, ttlMs: number): Promise<void> {
    const index = indexKey(keyspace);
    await this.client.set(key, value, "PX", ttlMs);
    await this.client.sadd(index, key);
    await this.client.pexpire(index, INDEX_TTL_MS);
  }

  async deleteKeyspace(keyspace: CacheKeyspace): Promise<void> {
    const index = indexKey(keyspace);
    const keys = await this.client.smembers(index);
    await this.client.del(index, ...keys);
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }
}

function indexKey(keyspace: CacheKeyspace): string {
  return `${CACHE_KEY_VERSION}:__index:${keyspace}`;
}
