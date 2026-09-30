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
}
