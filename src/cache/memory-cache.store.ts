import { CACHE_KEY_VERSION, CacheKeyspace, CacheStore } from "./cache.types";

interface Entry {
  value: string;
  keyspace: CacheKeyspace;
  expiresAt: number;
}

/**
 * Process-local cache store (issue #414). The default for dev/test and for
 * single-replica deploys. Bounded: past `maxEntries` the oldest insert is
 * evicted, so a key explosion cannot grow the heap without limit.
 */
export class MemoryCacheStore implements CacheStore {
  readonly kind = "memory" as const;
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, keyspace: CacheKeyspace, value: string, ttlMs: number): Promise<void> {
    // Re-insert so Map order tracks recency of writes for eviction.
    this.entries.delete(key);
    this.entries.set(key, { value, keyspace, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  async deleteKeyspace(keyspace: CacheKeyspace): Promise<void> {
    const prefix = `${CACHE_KEY_VERSION}:${keyspace}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  /** Number of live entries (tests). */
  size(): number {
    return this.entries.size;
  }
}
