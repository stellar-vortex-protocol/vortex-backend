import { EventEmitter } from "node:events";
import Redis from "ioredis";

/** Change notification: receivers reload the named flag from the DB. */
export interface FlagChangeMessage {
  key: string;
  version: number;
  /** Instance that made the change (lets it skip its own echo). */
  origin: string;
}

/** Pub/sub transport propagating flag changes across instances. */
export interface FlagBus {
  publish(msg: FlagChangeMessage): Promise<void>;
  subscribe(handler: (msg: FlagChangeMessage) => void): Promise<void>;
  close(): Promise<void>;
}

const CHANNEL = "vortex:flags:changed";

/**
 * In-process bus — a single instance, or several services in one test process.
 * `channel` lets other caches (e.g. the abuse allowlist) reuse the transport.
 */
export class InMemoryFlagBus implements FlagBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly channel: string = CHANNEL) {}

  async publish(msg: FlagChangeMessage): Promise<void> {
    this.emitter.emit(this.channel, msg);
  }

  async subscribe(handler: (msg: FlagChangeMessage) => void): Promise<void> {
    this.emitter.on(this.channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/** Redis pub/sub bus for multi-instance deploys (FLAGS_PUBSUB=redis). */
export class RedisFlagBus implements FlagBus {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(
    redisUrl: string,
    private readonly channel: string = CHANNEL,
  ) {
    this.pub = new Redis(redisUrl, { lazyConnect: true });
    this.sub = new Redis(redisUrl, { lazyConnect: true });
  }

  async publish(msg: FlagChangeMessage): Promise<void> {
    await this.pub.publish(this.channel, JSON.stringify(msg));
  }

  async subscribe(handler: (msg: FlagChangeMessage) => void): Promise<void> {
    this.sub.on("message", (channel: string, raw: string) => {
      if (channel === this.channel) handler(JSON.parse(raw));
    });
    await this.sub.subscribe(this.channel);
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
