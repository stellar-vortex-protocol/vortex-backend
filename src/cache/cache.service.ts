import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  CACHE_KEY_VERSION,
  CacheInvalidationBus,
  CacheInvalidationMessage,
  CacheKeyspace,
  CacheResult,
  CacheStore,
} from "./cache.types";

/** Hooks for hit/miss metrics; wired to Prometheus by CacheModule. */
export interface CacheMetricsSink {
  request(keyspace: CacheKeyspace, result: CacheResult): void;
  invalidation(keyspace: CacheKeyspace, source: "local" | "remote"): void;
}

export interface CacheServiceOptions {
  /** When false every read goes straight to the loader (CACHE_DRIVER=off). */
  enabled?: boolean;
  /** TTL jitter as a fraction of the TTL, in [0, 1). Default 0.1 (±10%). */
  jitter?: number;
  metrics?: CacheMetricsSink;
  random?: () => number;
}

/** Wrapper so `undefined` / `null` results are cacheable and distinguishable from a miss. */
interface Envelope<T> {
  v: T;
}

/**
 * Cache-aside read cache with event-driven invalidation (issue #414).
 *
 * - **Single-flight:** concurrent misses for the same key share one loader
 *   call, so a cold key under load costs one database query, not one per
 *   request.
 * - **Jittered TTL:** each write's TTL is spread by ±`jitter` so keys
 *   written together do not all expire (and stampede) together.
 * - **Invalidation:** {@link invalidate} drops the keyspace from the store
 *   and publishes on the bus so every replica drops its in-flight loads too.
 *   A per-keyspace generation counter stops a load that started before the
 *   invalidation from writing its now-stale result back.
 * - **Degradation:** any store or bus failure is counted and swallowed — a
 *   Redis outage makes reads slower (straight to the database), never errors.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly instanceId = randomUUID();
  private readonly inFlight = new Map<string, { keyspace: CacheKeyspace; promise: Promise<unknown> }>();
  private readonly generations = new Map<CacheKeyspace, number>();
  private readonly counts = new Map<string, number>();
  private readonly enabled: boolean;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(
    private readonly store: CacheStore,
    private readonly bus?: CacheInvalidationBus,
    private readonly options: CacheServiceOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.jitter = Math.min(Math.max(options.jitter ?? 0.1, 0), 0.99);
    this.random = options.random ?? Math.random;
  }

  /** Store backend in use ("memory" | "redis"). */
  get driver(): CacheStore["kind"] {
    return this.store.kind;
  }

  /** Start listening for invalidations published by other replicas. */
  async listen(): Promise<void> {
    if (!this.bus) return;
    await this.bus.subscribe((msg) => this.onRemoteInvalidation(msg));
  }

  /**
   * Return the cached value for `key`, or run `loader`, cache its result for
   * `ttlSeconds` (jittered) and return it.
   */
  async getOrLoad<T>(
    keyspace: CacheKeyspace,
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled || ttlSeconds <= 0) {
      this.record(keyspace, "bypass");
      return loader();
    }
    const fullKey = `${CACHE_KEY_VERSION}:${keyspace}:${key}`;

    // Join a load already in flight before touching the store, so a burst of
    // misses never fans out into a burst of store reads either.
    const pending = this.inFlight.get(fullKey);
    if (pending) {
      this.record(keyspace, "coalesced");
      return pending.promise as Promise<T>;
    }

    let storeHealthy = true;
    try {
      const raw = await this.store.get(fullKey);
      if (raw !== undefined) {
        this.record(keyspace, "hit");
        return (JSON.parse(raw) as Envelope<T>).v;
      }
    } catch (err) {
      storeHealthy = false;
      this.record(keyspace, "error");
      this.logger.debug(`[cache] get ${fullKey} failed, reading through: ${(err as Error).message}`);
    }

    // The store read yielded, so another caller may have started the load.
    const raced = this.inFlight.get(fullKey);
    if (raced) {
      this.record(keyspace, "coalesced");
      return raced.promise as Promise<T>;
    }

    if (storeHealthy) this.record(keyspace, "miss");
    const generation = this.generation(keyspace);
    const promise = (async () => {
      const value = await loader();
      if (storeHealthy && this.generation(keyspace) === generation) {
        await this.write(fullKey, keyspace, value, ttlSeconds);
      }
      return value;
    })();
    const entry = { keyspace, promise };
    this.inFlight.set(fullKey, entry);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(fullKey) === entry) this.inFlight.delete(fullKey);
    }
  }

  /**
   * Invalidate `keyspaces` on this replica and broadcast to the others.
   * Never throws; a failed store delete or publish is logged and the entry
   * ages out at its TTL instead.
   */
  async invalidate(...keyspaces: CacheKeyspace[]): Promise<void> {
    const unique = [...new Set(keyspaces)];
    // Synchronous part first: once this returns its first promise, no load
    // that started earlier can write back and no new caller joins one.
    for (const keyspace of unique) {
      this.dropLocal(keyspace);
      this.options.metrics?.invalidation(keyspace, "local");
    }
    await Promise.all(
      unique.map(async (keyspace) => {
        try {
          await this.store.deleteKeyspace(keyspace);
        } catch (err) {
          this.logger.warn(`[cache] delete ${keyspace} failed: ${(err as Error).message}`);
        }
        try {
          await this.bus?.publish({ keyspace, origin: this.instanceId });
        } catch (err) {
          this.logger.warn(`[cache] publish invalidation ${keyspace} failed: ${(err as Error).message}`);
        }
      }),
    );
  }

  /** Per-keyspace request counts by result, e.g. `{ "stats:hit": 3 }` (tests, diagnostics). */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  async onModuleDestroy(): Promise<void> {
    this.inFlight.clear();
    await this.bus?.close().catch(() => undefined);
    await this.store.close().catch(() => undefined);
  }

  private onRemoteInvalidation(msg: CacheInvalidationMessage): void {
    if (msg.origin === this.instanceId) return;
    this.dropLocal(msg.keyspace);
    this.options.metrics?.invalidation(msg.keyspace, "remote");
    // A shared Redis store was already cleared by the publisher; a local
    // memory store is per replica and must be cleared here.
    if (this.store.kind === "memory") {
      this.store.deleteKeyspace(msg.keyspace).catch(() => undefined);
    }
  }

  private dropLocal(keyspace: CacheKeyspace): void {
    this.generations.set(keyspace, this.generation(keyspace) + 1);
    for (const [key, entry] of this.inFlight) {
      if (entry.keyspace === keyspace) this.inFlight.delete(key);
    }
  }

  private generation(keyspace: CacheKeyspace): number {
    return this.generations.get(keyspace) ?? 0;
  }

  private async write<T>(fullKey: string, keyspace: CacheKeyspace, value: T, ttlSeconds: number): Promise<void> {
    const spread = 1 + (this.random() * 2 - 1) * this.jitter;
    const ttlMs = Math.max(1, Math.round(ttlSeconds * 1000 * spread));
    try {
      await this.store.set(fullKey, keyspace, JSON.stringify({ v: value } satisfies Envelope<T>), ttlMs);
    } catch (err) {
      this.record(keyspace, "error");
      this.logger.debug(`[cache] set ${fullKey} failed: ${(err as Error).message}`);
    }
  }

  private record(keyspace: CacheKeyspace, result: CacheResult): void {
    const label = `${keyspace}:${result}`;
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
    this.options.metrics?.request(keyspace, result);
  }
}
