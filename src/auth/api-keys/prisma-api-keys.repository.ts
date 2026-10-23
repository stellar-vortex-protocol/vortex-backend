import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ApiKeyTier } from "./api-key-tiers";

/**
 * Persistence for API keys (issue #441).
 *
 * Stores only the SHA-256 hash and the non-secret lookup prefix — never the
 * plaintext.  Lookups go through `keyPrefix` so the hot path never needs to
 * load or compare full hashes until a candidate prefix matches.
 */
@Injectable()
export class PrismaApiKeysRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Look up a key by its non-secret prefix. Returns the stored hash and
   * metadata needed for verification and tier resolution, or `null` when no
   * key has this prefix.
   */
  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findUnique({ where: { keyPrefix: prefix } });
    return row ? this.toRecord(row) : null;
  }

  /** List active (non-revoked) keys for an owner, newest first. */
  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { owner },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toRecord(r));
  }

  /** Fetch a single key record by id (used by rotate/revoke). */
  async findById(id: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  /** Create a key record from an already-generated credential. */
  async create(data: {
    keyPrefix: string;
    keyHash: string;
    tier: ApiKeyTier;
    owner: string;
    scopes: string[];
    expiresAt: number | null;
  }): Promise<ApiKeyRecord> {
    const row = await this.prisma.apiKey.create({
      data: {
        keyPrefix: data.keyPrefix,
        keyHash: data.keyHash,
        tier: data.tier as ApiKeyTier,
        owner: data.owner,
        scopes: data.scopes as unknown as object,
        createdAt: Math.floor(Date.now() / 1000),
        ...(data.expiresAt !== null ? { expiresAt: data.expiresAt } : {}),
      },
    });
    return this.toRecord(row);
  }

  /** Mark a key revoked at the given epoch seconds. */
  async revoke(id: string, nowSec: number): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: nowSec },
    });
  }

  /** Record last usage (best-effort; never throws into the request path). */
  async touchLastUsed(id: string, nowSec: number): Promise<void> {
    try {
      await this.prisma.apiKey.update({
        where: { id },
        data: { lastUsedAt: nowSec },
      });
    } catch {
      // Usage tracking is best-effort.
    }
  }

  /**
   * Increment the per-key, per-bucket request counter (issue #705).
   *
   * Uses an atomic upsert on the `[apiKeyId, bucketStart]` unique key so
   * concurrent requests in the same bucket never lose increments.  Wrapped in
   * try/catch so usage tracking never throws into the hot throttle path.
   */
  async incrementUsage(apiKeyId: string, bucketStart: number, allowed: boolean): Promise<void> {
    try {
      await this.prisma.apiKeyUsageBucket.upsert({
        where: { api_key_usage_bucket_key: { apiKeyId, bucketStart } },
        create: {
          apiKeyId,
          bucketStart,
          allowedCount: allowed ? 1 : 0,
          throttledCount: allowed ? 0 : 1,
        },
        update: allowed
          ? { allowedCount: { increment: 1 } }
          : { throttledCount: { increment: 1 } },
      });
    } catch {
      // Usage tracking is best-effort.
    }
  }

  /** Fetch usage buckets for a key within `[fromSec, toSec]`, oldest first. */
  async getUsage(apiKeyId: string, fromSec: number, toSec: number): Promise<ApiKeyUsageBucket[]> {
    const rows = await this.prisma.apiKeyUsageBucket.findMany({
      where: { apiKeyId, bucketStart: { gte: fromSec, lte: toSec } },
      orderBy: { bucketStart: "asc" },
    });
    return rows.map((r) => ({
      bucketStart: r.bucketStart,
      allowedCount: r.allowedCount,
      throttledCount: r.throttledCount,
    }));
  }

  /** Delete usage buckets older than `cutoffSec` (retention pruning). */
  async pruneUsageBefore(cutoffSec: number): Promise<number> {
    const result = await this.prisma.apiKeyUsageBucket.deleteMany({
      where: { bucketStart: { lt: cutoffSec } },
    });
    return result.count;
  }

  async pruneUsage(cutoffSec: number): Promise<number> {
    return this.pruneUsageBefore(cutoffSec);
  }

  /**
   * Find active (non-revoked, non-expired) keys whose `expiresAt` falls within
   * `[nowSec, untilSec]` (issue #708).
   */
  async findExpiringBetween(nowSec: number, untilSec: number): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: {
        revokedAt: null,
        expiresAt: { not: null, gte: nowSec, lte: untilSec },
      },
      orderBy: { expiresAt: "asc" },
    });
    return rows.map((r) => this.toRecord(r));
  }

  /** Record that an expiry warning was emitted for a key (best-effort). */
  async markExpiryWarned(id: string, nowSec: number): Promise<void> {
    try {
      await this.prisma.apiKey.update({
        where: { id },
        data: { lastWarnedAt: nowSec },
      });
    } catch {
      // Warning bookkeeping is best-effort.
    }
  }

  private toRecord(row: {
    id: string;
    keyPrefix: string;
    keyHash: string;
    tier: ApiKeyTier;
    owner: string;
    scopes: unknown;
    createdAt: number;
    revokedAt: number | null;
    expiresAt: number | null;
    lastUsedAt: number | null;
    lastWarnedAt: number | null;
  }): ApiKeyRecord {
    return {
      id: row.id,
      keyPrefix: row.keyPrefix,
      keyHash: row.keyHash,
      tier: row.tier,
      owner: row.owner,
      scopes: (row.scopes as string[]) ?? [],
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      lastWarnedAt: row.lastWarnedAt,
    };
  }
}

/** A stored API key record (hash + metadata, never the plaintext). */
export interface ApiKeyRecord {
  id: string;
  keyPrefix: string;
  keyHash: string;
  tier: ApiKeyTier;
  owner: string;
  scopes: string[];
  createdAt: number;
  revokedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastWarnedAt: number | null;
}

/** A single per-key usage time bucket (issue #705). */
export interface ApiKeyUsageBucket {
  bucketStart: number;
  allowedCount: number;
  throttledCount: number;
}
