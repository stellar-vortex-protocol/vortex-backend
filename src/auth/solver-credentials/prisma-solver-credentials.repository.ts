import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Persistence for scoped solver credentials (issue #443).
 *
 * Like API keys, only the SHA-256 hash and a non-secret prefix are stored.
 * Credentials are bound to a solver's on-chain address and carry scopes,
 * an optional IP allowlist, an expiry, and revocation state.
 */
@Injectable()
export class PrismaSolverCredentialsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Look up a credential by its non-secret prefix. */
  async findByPrefix(prefix: string): Promise<SolverCredentialRecord | null> {
    const row = await this.prisma.solverCredential.findUnique({ where: { credPrefix: prefix } });
    return row ? this.toRecord(row) : null;
  }

  /** List a solver's credentials, newest first (metadata only). */
  async listBySolver(solverAddress: string): Promise<SolverCredentialRecord[]> {
    const rows = await this.prisma.solverCredential.findMany({
      where: { solverAddress },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toRecord(r));
  }

  /** Fetch a single credential by id. */
  async findById(id: string): Promise<SolverCredentialRecord | null> {
    const row = await this.prisma.solverCredential.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(data: {
    credPrefix: string;
    credHash: string;
    solverAddress: string;
    scopes: string[];
    ipAllowlist: string[] | null;
    expiresAt: number | null;
  }): Promise<SolverCredentialRecord> {
    const row = await this.prisma.solverCredential.create({
      data: {
        credPrefix: data.credPrefix,
        credHash: data.credHash,
        solverAddress: data.solverAddress,
        scopes: data.scopes as unknown as object,
        ...(data.ipAllowlist !== null ? { ipAllowlist: data.ipAllowlist as unknown as object } : {}),
        createdAt: Math.floor(Date.now() / 1000),
        ...(data.expiresAt !== null ? { expiresAt: data.expiresAt } : {}),
      },
    });
    return this.toRecord(row);
  }

  /**
   * Replace a credential's IP allowlist in a single write (issue #702).
   * Passing `null` clears the restriction (allow all).
   */
  async updateIpAllowlist(
    id: string,
    ipAllowlist: string[] | null,
  ): Promise<SolverCredentialRecord> {
    const row = await this.prisma.solverCredential.update({
      where: { id },
      data: { ipAllowlist: ipAllowlist as unknown as object },
    });
    return this.toRecord(row);
  }

  /** Revoke a credential at the given epoch seconds. */
  async revoke(id: string, nowSec: number): Promise<void> {
    await this.prisma.solverCredential.update({
      where: { id },
      data: { revokedAt: nowSec },
    });
  }

  /** Mark a credential rotated (records when the previous credential was superseded). */
  async markRotated(id: string, nowSec: number): Promise<void> {
    await this.prisma.solverCredential.update({
      where: { id },
      data: { rotatedAt: nowSec },
    });
  }

  /** Disable every active credential for a solver (deregister / slash / deactivate). */
  async disableAllForSolver(solverAddress: string, nowSec: number): Promise<number> {
    const result = await this.prisma.solverCredential.updateMany({
      where: { solverAddress, revokedAt: null },
      data: { revokedAt: nowSec },
    });
    return result.count;
  }

  /**
   * Find active credentials whose `expiresAt` falls within `[nowSec, untilSec]`
   * (inclusive on both ends). Revoked credentials and already-expired ones are
   * excluded. Used by the scheduled expiry-warning job (issue #708).
   */
  async findExpiringBetween(nowSec: number, untilSec: number): Promise<SolverCredentialRecord[]> {
    const rows = await this.prisma.solverCredential.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gte: nowSec, lte: untilSec },
      },
      orderBy: { expiresAt: "asc" },
    });
    return rows.map((r) => this.toRecord(r));
  }

  /** Record that an expiry warning was emitted for this credential (issue #708). */
  async markExpiryWarned(id: string, nowSec: number): Promise<void> {
    await this.prisma.solverCredential.update({
      where: { id },
      data: { lastWarnedAt: nowSec },
    });
  }

  /** Record last usage (best-effort). */
  async touchLastUsed(id: string, nowSec: number): Promise<void> {
    try {
      await this.prisma.solverCredential.update({
        where: { id },
        data: { lastUsedAt: nowSec },
      });
    } catch {
      // Usage tracking is best-effort.
    }
  }

  private toRecord(row: {
    id: string;
    credPrefix: string;
    credHash: string;
    solverAddress: string;
    scopes: unknown;
    ipAllowlist: unknown;
    createdAt: number;
    expiresAt: number | null;
    revokedAt: number | null;
    rotatedAt: number | null;
    lastUsedAt: number | null;
    lastWarnedAt?: number | null;
  }): SolverCredentialRecord {
    return {
      id: row.id,
      credPrefix: row.credPrefix,
      credHash: row.credHash,
      solverAddress: row.solverAddress,
      scopes: (row.scopes as string[]) ?? [],
      ipAllowlist: (row.ipAllowlist as string[] | null) ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      rotatedAt: row.rotatedAt,
      lastUsedAt: row.lastUsedAt,
      lastWarnedAt: row.lastWarnedAt ?? null,
    };
  }
}

/** A stored solver credential (hash + metadata, never the plaintext). */
export interface SolverCredentialRecord {
  id: string;
  credPrefix: string;
  credHash: string;
  solverAddress: string;
  scopes: string[];
  ipAllowlist: string[] | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  rotatedAt: number | null;
  lastUsedAt: number | null;
  /** Epoch seconds of the last expiry warning emitted for this credential. */
  lastWarnedAt: number | null;
}
