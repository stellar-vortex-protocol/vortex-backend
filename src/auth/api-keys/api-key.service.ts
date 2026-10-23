import { Injectable, Logger } from "@nestjs/common";
import { PrismaApiKeysRepository, ApiKeyRecord } from "./prisma-api-keys.repository";
import { ApiKeyTier } from "./api-key-tiers";
import { generateCredential, verifyCredential } from "../credential-hashing";

/**
 * API key lifecycle service (issue #441).
 *
 * Responsibilities:
 *  - Create keys (plaintext shown once, only the hash is persisted).
 *  - Verify a presented key against its stored hash (constant-time).
 *  - Rotate keys (revoke the old, issue a new one).
 *  - Revoke keys instantly.
 *
 * The service never logs or returns plaintext secrets after creation.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(private readonly repo: PrismaApiKeysRepository) {}

  /**
   * Create a new API key. The plaintext is returned exactly once — it cannot
   * be recovered later because only its SHA-256 hash is stored.
   */
  async createKey(input: {
    tier: ApiKeyTier;
    owner: string;
    scopes?: string[];
    expiresAt?: number | null;
  }): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const credential = generateCredential();
    const record = await this.repo.create({
      keyPrefix: credential.prefix,
      keyHash: credential.hash,
      tier: input.tier,
      owner: input.owner,
      scopes: input.scopes ?? [],
      expiresAt: input.expiresAt ?? null,
    });
    this.logger.log(`API key created tier=${input.tier} owner=${input.owner} prefix=${credential.prefix}`);
    return { record, plaintext: credential.plaintext };
  }

  /**
   * Resolve a presented plaintext key to its record.
   *
   * Lookup is a two-step process: the non-secret prefix selects the candidate
   * row, then the presented secret is compared against the stored hash in
   * constant time. Returns `null` for unknown prefixes, revoked keys, and
   * expired keys — the caller cannot distinguish these cases, which avoids
   * leaking key state.
   */
  async resolveKey(plaintext: string): Promise<ApiKeyRecord | null> {
    if (!plaintext || plaintext.length < 16) return null;
    const prefix = plaintext.slice(0, 8);
    const record = await this.repo.findByPrefix(prefix);
    if (!record) return null;
    if (record.revokedAt !== null) return null;
    if (record.expiresAt !== null && record.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    if (!verifyCredential(plaintext, record.keyHash)) return null;
    void this.repo.touchLastUsed(record.id, Math.floor(Date.now() / 1000));
    return record;
  }

  /** Whether a record is currently usable (not revoked, not expired). */
  isActive(record: ApiKeyRecord, nowSec = Math.floor(Date.now() / 1000)): boolean {
    if (record.revokedAt !== null) return false;
    if (record.expiresAt !== null && record.expiresAt <= nowSec) return false;
    return true;
  }

  /** Revoke a key instantly. Idempotent — revoking an already-revoked key is a no-op. */
  async revokeKey(id: string): Promise<void> {
    await this.repo.revoke(id, Math.floor(Date.now() / 1000));
    this.logger.log(`API key revoked id=${id}`);
  }

  /** Fetch a single key record by id (metadata only — never plaintext). */
  async getKey(id: string): Promise<ApiKeyRecord | null> {
    return this.repo.findById(id);
  }

  /** List keys for an owner (metadata only — never plaintext). */
  async listKeys(owner: string): Promise<ApiKeyRecord[]> {
    return this.repo.listByOwner(owner);
  }

  /**
   * Create a self-service API key for an integrator (issue #707).
   *
   * The tier is hard-coded to `integrator` — callers cannot influence it, so
   * the public signup flow can never mint a `solver` or `partner` key.
   */
  async createSelfServiceKey(
    email: string,
  ): Promise<{ record: ApiKeyRecord; plaintext: string; apiKey: string; tier: ApiKeyTier }> {
    const created = await this.createKey({ tier: "integrator", owner: email });
    return {
      ...created,
      apiKey: created.plaintext,
      tier: created.record.tier,
    };
  }

  /**
   * Record one request against a key's current hourly usage bucket
   * (issue #705). Fire-and-forget: usage tracking must never add latency to
   * (or fail) the hot throttle path.
   */
  recordUsage(keyId: string, allowed: boolean, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
    const bucketStart = Math.floor(nowSec / 3600) * 3600;
    return this.repo.incrementUsage(keyId, bucketStart, allowed).catch((err: unknown) => {
      this.logger.debug(`Failed to record API key usage id=${keyId}: ${String(err)}`);
    });
  }

  /**
   * Fetch bucketed usage for a key between `from` (inclusive) and `to`
   * (exclusive), with allowed-vs-throttled totals.
   */
  async getUsage(
    id: string,
    from: number | Date,
    to: number | Date,
  ): Promise<{
    buckets: Array<{ start: Date; bucketStart: number; allowed: number; throttled: number }>;
    totals: { allowed: number; throttled: number };
  }> {
    const fromSec = from instanceof Date ? Math.floor(from.getTime() / 1000) : from;
    const toSec = to instanceof Date ? Math.floor(to.getTime() / 1000) : to;
    const rawBuckets = await this.repo.getUsage(id, fromSec, toSec);
    const buckets = rawBuckets.map((b) => ({
      start: new Date(b.bucketStart * 1000),
      bucketStart: b.bucketStart,
      allowed: b.allowedCount,
      throttled: b.throttledCount,
    }));
    const totals = buckets.reduce(
      (acc, b) => ({ allowed: acc.allowed + b.allowed, throttled: acc.throttled + b.throttled }),
      { allowed: 0, throttled: 0 },
    );
    return { buckets, totals };
  }

  /** Delete usage buckets older than `retentionSec` (bounded table growth). */
  async pruneUsage(retentionSec: number, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
    return this.repo.pruneUsageBefore(nowSec - retentionSec);
  }

  /** Keys whose `expiresAt` falls within the next `windowSec` seconds (issue #708). */
  async findExpiringSoon(windowSec: number, nowSec = Math.floor(Date.now() / 1000)): Promise<ApiKeyRecord[]> {
    return this.repo.findExpiringBetween(nowSec, nowSec + windowSec);
  }

  async findExpiringBetween(from: number | Date, to: number | Date): Promise<ApiKeyRecord[]> {
    const fromSec = from instanceof Date ? Math.floor(from.getTime() / 1000) : from;
    const toSec = to instanceof Date ? Math.floor(to.getTime() / 1000) : to;
    return this.repo.findExpiringBetween(fromSec, toSec);
  }

  /** Mark a key as having been warned about its upcoming expiry. */
  async markExpiryWarned(id: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.repo.markExpiryWarned(id, nowSec);
  }
}
