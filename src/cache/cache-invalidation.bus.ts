import { EventEmitter } from "node:events";
import Redis from "ioredis";
import { CacheInvalidationBus, CacheInvalidationMessage } from "./cache.types";

const CHANNEL = "vortex:cache:invalidate";

/** In-process bus: a single replica, or several services in one test process. */
export class InMemoryCacheInvalidationBus implements CacheInvalidationBus {
  private readonly emitter = new EventEmitter();

  async publish(msg: CacheInvalidationMessage): Promise<void> {
    this.emitter.emit(CHANNEL, msg);
  }

  async subscribe(handler: (msg: CacheInvalidationMessage) => void): Promise<void> {
    this.emitter.on(CHANNEL, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/**
 * Redis pub/sub bus (issue #414) — every replica drops its in-flight loads
 * (and, with the memory store, its local entries) for the keyspace.
 * Delivery is best-effort: a replica that misses a message serves a stale
 * entry for at most one TTL.
 */
export class RedisCacheInvalidationBus implements CacheInvalidationBus {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    this.sub = new Redis(redisUrl, { lazyConnect: true });
    this.pub.on("error", () => undefined);
    this.sub.on("error", () => undefined);
  }

  async publish(msg: CacheInvalidationMessage): Promise<void> {
    if (this.pub.status === "wait") await this.pub.connect().catch(() => undefined);
    await this.pub.publish(CHANNEL, JSON.stringify(msg));
  }

  async subscribe(handler: (msg: CacheInvalidationMessage) => void): Promise<void> {
    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw) as CacheInvalidationMessage);
      } catch {
        // A malformed message must not take down the subscriber.
      }
    });
    await this.sub.subscribe(CHANNEL);
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
