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
}
