/**
 * Read-path cache contracts (issue #414).
 *
 * Every key is versioned (`v1:<keyspace>:<key>`) so a change to a cached
 * value's shape ships with a version bump instead of a flush.
 */

/** Bump when the shape of any cached value changes incompatibly. */
export const CACHE_KEY_VERSION = "v1";

/**
 * Groups of keys that are invalidated together. A domain event invalidates a
 * whole keyspace rather than individual keys: the keyspaces are small
 * (a handful of keys each), so precision is not worth the bookkeeping.
 */
export type CacheKeyspace = "tokens" | "solvers" | "leaderboard" | "stats";

export const CACHE_KEYSPACES: readonly CacheKeyspace[] = ["tokens", "solvers", "leaderboard", "stats"];

/** Backing store. Values are opaque strings; the service owns serialisation. */
export interface CacheStore {
  readonly kind: "memory" | "redis";
  get(key: string): Promise<string | undefined>;
  set(key: string, keyspace: CacheKeyspace, value: string, ttlMs: number): Promise<void>;
  /** Remove every key written under `keyspace`. */
  deleteKeyspace(keyspace: CacheKeyspace): Promise<void>;
  close(): Promise<void>;
}

/** Cross-replica invalidation notice. */
export interface CacheInvalidationMessage {
  keyspace: CacheKeyspace;
  /** Instance id of the publisher, so it can skip its own echo. */
  origin: string;
}

/** Pub/sub transport fanning invalidations out to every replica. */
export interface CacheInvalidationBus {
  publish(msg: CacheInvalidationMessage): Promise<void>;
  subscribe(handler: (msg: CacheInvalidationMessage) => void): Promise<void>;
  close(): Promise<void>;
}

/** Outcome label for `vortex_cache_requests_total{keyspace,result}`. */
export type CacheResult = "hit" | "miss" | "coalesced" | "error" | "bypass";
