import { EventEmitter } from "node:events";
import Redis from "ioredis";

/** Revocation invalidation message broadcast to every replica (issue #443). */
export interface CredentialRevocationMessage {
  /** Credential id that was revoked or auto-disabled. */
  credentialId: string;
  /** Credential prefix (for cache invalidation without a DB lookup). */
  credPrefix: string;
  /** Solver address whose credential was revoked. */
  solverAddress: string;
  /** Unix epoch seconds of the revocation. */
  revokedAt: number;
  /** Why the credential was revoked: "revoked" | "rotated" | "solver-disabled". */
  reason: "revoked" | "rotated" | "solver-disabled";
}

/** Pub/sub transport propagating credential revocations across instances. */
export interface CredentialRevocationBus {
  publish(msg: CredentialRevocationMessage): Promise<void>;
  subscribe(handler: (msg: CredentialRevocationMessage) => void): Promise<void>;
  close(): Promise<void>;
}

/** Injection token for the active {@link CredentialRevocationBus}. */
export const CREDENTIAL_REVOCATION_BUS = Symbol("CREDENTIAL_REVOCATION_BUS");

const CHANNEL = "vortex:credentials:revoked";

/** In-process bus — a single instance, or several services in one test process. */
export class InMemoryCredentialRevocationBus implements CredentialRevocationBus {
  private readonly emitter = new EventEmitter();

  async publish(msg: CredentialRevocationMessage): Promise<void> {
    this.emitter.emit(CHANNEL, msg);
  }

  async subscribe(handler: (msg: CredentialRevocationMessage) => void): Promise<void> {
    this.emitter.on(CHANNEL, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/** Redis pub/sub bus for multi-instance deploys (uses REDIS_URL). */
export class RedisCredentialRevocationBus implements CredentialRevocationBus {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: true });
    this.sub = new Redis(redisUrl, { lazyConnect: true });
  }

  async publish(msg: CredentialRevocationMessage): Promise<void> {
    await this.pub.publish(CHANNEL, JSON.stringify(msg));
  }

  async subscribe(handler: (msg: CredentialRevocationMessage) => void): Promise<void> {
    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw) as CredentialRevocationMessage);
      } catch {
        // Ignore malformed messages.
      }
    });
    await this.sub.subscribe(CHANNEL);
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
