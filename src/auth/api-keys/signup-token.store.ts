import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Injection token for the signup verification-token store.
 */
export const SIGNUP_TOKEN_STORE = Symbol('SIGNUP_TOKEN_STORE');

/**
 * Default lifetime for a signup verification token, in seconds (15 minutes).
 */
export const DEFAULT_SIGNUP_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * A short-lived, single-use store for API-key signup verification tokens.
 *
 * Mirrors the design of `src/auth/sep10/nonce.store.ts`: tokens are remembered
 * with a TTL and can be consumed exactly once. `consume` must be atomic so that
 * two concurrent confirmations cannot both succeed with the same token.
 */
export interface SignupTokenStore {
  /**
   * Persist `tokenOrEmail` for `ttlSeconds`. If called with a single argument
   * (an email address), generates and returns a new random token mapped to that email.
   */
  remember(tokenOrEmail: string, ttlSeconds?: number): Promise<string>;

  /**
   * Atomically consume `token`. Returns the associated email (or `'1'` when
   * stored without an email) if the token existed and was removed, or `null`
   * if it was missing or already expired/consumed.
   */
  consume(token: string): Promise<string | null>;
}

interface StoredToken {
  value: string;
  expiresAt: number;
}

/**
 * In-memory implementation suitable for single-instance deployments and tests.
 */
@Injectable()
export class InMemorySignupTokenStore implements SignupTokenStore, OnModuleDestroy {
  private readonly logger = new Logger(InMemorySignupTokenStore.name);
  private readonly tokens = new Map<string, StoredToken>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    // Periodically evict expired tokens so the map does not grow unbounded.
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    if (typeof this.sweeper.unref === 'function') {
      this.sweeper.unref();
    }
  }

  async remember(tokenOrEmail: string, ttlSeconds = DEFAULT_SIGNUP_TOKEN_TTL_SECONDS): Promise<string> {
    if (tokenOrEmail.includes('@')) {
      const token = randomBytes(24).toString('base64url');
      this.tokens.set(token, {
        value: tokenOrEmail,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return token;
    }
    this.tokens.set(tokenOrEmail, {
      value: tokenOrEmail,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return tokenOrEmail;
  }

  async consume(token: string): Promise<string | null> {
    const entry = this.tokens.get(token);
    if (!entry) {
      return null;
    }
    // Delete before checking expiry so the token is single-use regardless.
    this.tokens.delete(token);
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    return entry.value;
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    this.tokens.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}

/**
 * Redis-backed implementation for multi-instance deployments.
 *
 * Uses `SETEX` for storage and a `GET`+`DEL` Lua script for atomic consumption.
 */
@Injectable()
export class RedisSignupTokenStore implements SignupTokenStore, OnModuleDestroy {
  private readonly logger = new Logger(RedisSignupTokenStore.name);
  private readonly client: Redis;
  private readonly keyPrefix = 'api-key-signup:token:';

  // Atomically read and delete the key. Returns the value (or nil).
  private static readonly CONSUME_SCRIPT = `
    local value = redis.call('GET', KEYS[1])
    if value then
      redis.call('DEL', KEYS[1])
    end
    return value
  `;

  constructor(configOrUrl: ConfigService | string) {
    if (typeof configOrUrl === 'string') {
      this.client = new Redis(configOrUrl);
      return;
    }
    const url = configOrUrl.get<string>('REDIS_URL');
    this.client = url
      ? new Redis(url)
      : new Redis({
          host: configOrUrl.get<string>('REDIS_HOST', 'localhost'),
          port: configOrUrl.get<number>('REDIS_PORT', 6379),
          password: configOrUrl.get<string>('REDIS_PASSWORD') || undefined,
          db: configOrUrl.get<number>('REDIS_DB', 0),
        });
  }

  async remember(tokenOrEmail: string, ttlSeconds = DEFAULT_SIGNUP_TOKEN_TTL_SECONDS): Promise<string> {
    if (tokenOrEmail.includes('@')) {
      const token = randomBytes(24).toString('base64url');
      await this.client.setex(this.key(token), ttlSeconds, tokenOrEmail);
      return token;
    }
    await this.client.setex(this.key(tokenOrEmail), ttlSeconds, tokenOrEmail);
    return tokenOrEmail;
  }

  async consume(token: string): Promise<string | null> {
    const result = await this.client.eval(
      RedisSignupTokenStore.CONSUME_SCRIPT,
      1,
      this.key(token),
    );
    return typeof result === 'string' && result.length > 0 ? result : null;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch (err) {
      this.logger.warn(`Error closing Redis client: ${(err as Error).message}`);
    }
  }

  private key(token: string): string {
    return `${this.keyPrefix}${token}`;
  }
}
