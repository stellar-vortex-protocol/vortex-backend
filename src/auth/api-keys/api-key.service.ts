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
}
