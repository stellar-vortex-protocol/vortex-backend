import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { AdminAuditService } from "../../admin/admin-audit.service";
import { PrismaSolverCredentialsRepository, SolverCredentialRecord } from "./prisma-solver-credentials.repository";
import { generateCredential, verifyCredential } from "../credential-hashing";
import { scopeAllows, SolverScope } from "./solver-scopes";
import {
  CREDENTIAL_REVOCATION_BUS,
  CredentialRevocationBus,
  CredentialRevocationMessage,
  InMemoryCredentialRevocationBus,
} from "./credential-revocation.bus";

/**
 * How long a verified active credential is cached before it is re-checked
 * against the database.  Bounds staleness during a Redis outage (when pub/sub
 * invalidation is unavailable); with Redis up, revocation propagates in
 * milliseconds via pub/sub, so the TTL is only a safety net.
 */
const CACHE_TTL_MS = 60_000;

interface CachedCredential {
  record: SolverCredentialRecord;
  /** Unix ms when this cache entry becomes stale. */
  expiresAt: number;
}

/** A verified credential principal (attached to the request by the guard). */
export interface SolverCredentialPrincipal {
  credentialId: string;
  credPrefix: string;
  solverAddress: string;
  scopes: string[];
  /**
   * Source addresses this credential may be used from, or `null` for no
   * restriction. Enforced by {@link SolverCredentialGuard}.
   */
  ipAllowlist: string[] | null;
}

/**
 * Scoped solver credential lifecycle service (issue #443).
 *
 * Responsibilities:
 *  - Create credentials bound to a solver's on-chain address (hashed storage).
 *  - Verify a presented credential → principal (constant-time, deny by default).
 *  - Rotate with an overlapping validity window.
 *  - Revoke instantly, propagating to every replica via pub/sub (< 5 s).
 *  - Auto-disable every credential of a deregistered / deactivated solver.
 *  - Audit every lifecycle event.
 *
 * Verification uses a local cache of active credentials plus a revoked-id set.
 * Revocation and solver-disabling invalidate the cache on every replica through
 * the {@link CredentialRevocationBus}, so a revoked credential stops working
 * cluster-wide within seconds.  The database remains the source of truth on a
 * cache miss, so a replica that started after a revocation still denies it.
 */
@Injectable()
export class SolverCredentialService implements OnModuleDestroy {
  private readonly logger = new Logger(SolverCredentialService.name);
  private readonly activeCache = new Map<string, CachedCredential>();
  private readonly revokedSet = new Set<string>();
  private readonly bus: CredentialRevocationBus;

  constructor(
    private readonly repo: PrismaSolverCredentialsRepository,
    private readonly audit: AdminAuditService,
    config: ConfigService<AppConfig, true>,
    @Optional() @Inject(CREDENTIAL_REVOCATION_BUS) bus?: CredentialRevocationBus,
  ) {
    this.bus = bus ?? new InMemoryCredentialRevocationBus();
    void this.bus
      .subscribe((msg) => this.onRevocationMessage(msg))
      .catch((err: Error) => this.logger.error(`credential revocation subscribe failed: ${err.message}`));
  }

  /**
   * Create a credential for a solver.  The plaintext is returned ONCE; only
   * its hash is stored.  Scopes are validated against the allowed set.
   */
  async createCredential(input: {
    solverAddress: string;
    scopes: string[];
    ipAllowlist?: string[] | null;
    expiresAt?: number | null;
  }): Promise<{ record: SolverCredentialRecord; plaintext: string }> {
    const credential = generateCredential();
    const record = await this.repo.create({
      credPrefix: credential.prefix,
      credHash: credential.hash,
      solverAddress: input.solverAddress,
      scopes: input.scopes,
      ipAllowlist: input.ipAllowlist ?? null,
      expiresAt: input.expiresAt ?? null,
    });
    await this.audit.record({
      actor: input.solverAddress,
      action: "solver-credential.create",
      target: `solver-credential:${record.id}`,
      after: { credPrefix: record.credPrefix, scopes: record.scopes, expiresAt: record.expiresAt },
    });
    this.logger.log(`solver credential created solver=${input.solverAddress} prefix=${credential.prefix}`);
    return { record, plaintext: credential.plaintext };
  }

  /**
   * Resolve a presented credential to a principal.
   *
   * Deny by default: unknown prefix, bad hash, revoked, expired, or a solver
   * that is no longer active all resolve to `null`.  The local cache serves
   * repeated verifications without a DB round-trip; the revoked-id set and
   * pub/sub invalidation keep it consistent across replicas.
   *
   * The prefix is a LOOKUP handle, not a credential: it is short, it is
   * returned in API listings, audit rows and logs, and it is the rate-limit
   * tracker. The presented secret is therefore always verified against the
   * stored hash — on a cache hit as well as a miss. Skipping that check on the
   * cached path would let anyone who learned a prefix authenticate as that
   * credential.
   */
  async resolveCredential(plaintext: string, nowSec = Math.floor(Date.now() / 1000)): Promise<SolverCredentialPrincipal | null> {
    if (!plaintext || plaintext.length < 16) return null;
    const prefix = plaintext.slice(0, 8);

    const cached = this.activeCache.get(prefix);
    if (cached && cached.expiresAt > nowSec * 1000) {
      if (this.revokedSet.has(cached.record.id)) return null;
      if (!verifyCredential(plaintext, cached.record.credHash)) return null;
      return this.toPrincipal(cached.record);
    }

    const record = await this.repo.findByPrefix(prefix);
    if (!record) return null;
    if (this.revokedSet.has(record.id)) return null;
    if (record.revokedAt !== null) {
      this.revokedSet.add(record.id);
      return null;
    }
    if (record.expiresAt !== null && record.expiresAt <= nowSec) {
      return null;
    }
    // Constant-time comparison of the presented secret against the stored hash.
    // Checked before the credential is cached, so a forged secret can never
    // occupy the cache slot for the real one.
    if (!verifyCredential(plaintext, record.credHash)) return null;

    // Cache the active credential (TTL-bounded; pub/sub invalidates on change).
    this.activeCache.set(prefix, { record, expiresAt: Date.now() + CACHE_TTL_MS });
    void this.repo.touchLastUsed(record.id, nowSec);
    return this.toPrincipal(record);
  }

  /**
   * Whether a principal's scopes permit an operation (deny by default).
   */
  scopeAllows(principal: SolverCredentialPrincipal | null, operation: string): boolean {
    if (!principal) return false;
    return scopeAllows(principal.scopes, operation);
  }

  /**
   * Rotate a credential: revoke the old one and issue a replacement with the
   * same scopes/allowlist.  The old credential is revoked immediately; the
   * overlap window is the cache TTL, during which a replica that has not yet
   * received the pub/sub invalidation may still accept the old credential.
   * Callers that need zero overlap should wait for propagation before
   * considering the rotation complete.
   */
  async rotateCredential(
    id: string,
    newScopes?: string[],
  ): Promise<{ record: SolverCredentialRecord; plaintext: string } | null> {
    const current = await this.repo.findById(id);
    if (!current) return null;

    const credential = generateCredential();
    const record = await this.repo.create({
      credPrefix: credential.prefix,
      credHash: credential.hash,
      solverAddress: current.solverAddress,
      scopes: newScopes ?? current.scopes,
      ipAllowlist: current.ipAllowlist,
      expiresAt: current.expiresAt,
    });

    await this.repo.markRotated(id, Math.floor(Date.now() / 1000));
    await this.revokeCredential(id, "rotated");

    await this.audit.record({
      actor: current.solverAddress,
      action: "solver-credential.rotate",
      target: `solver-credential:${id}`,
      before: { credPrefix: current.credPrefix },
      after: { credPrefix: record.credPrefix, scopes: record.scopes },
    });

    return { record, plaintext: credential.plaintext };
  }

  /**
   * Revoke a credential instantly and propagate the revocation to every
   * replica via pub/sub.  Idempotent.
   */
  async revokeCredential(id: string, reason: "revoked" | "rotated" | "solver-disabled" = "revoked"): Promise<void> {
    const record = await this.repo.findById(id);
    await this.repo.revoke(id, Math.floor(Date.now() / 1000));
    this.revokedSet.add(id);
    this.activeCache.delete(record?.credPrefix ?? "");

    const msg: CredentialRevocationMessage = {
      credentialId: id,
      credPrefix: record?.credPrefix ?? "",
      solverAddress: record?.solverAddress ?? "",
      revokedAt: Math.floor(Date.now() / 1000),
      reason,
    };
    try {
      await this.bus.publish(msg);
    } catch (err) {
      this.logger.error(`failed to publish credential revocation: ${(err as Error).message}`);
    }

    await this.audit.record({
      actor: record?.solverAddress ?? "system",
      action: "solver-credential.revoke",
      target: `solver-credential:${id}`,
      after: { reason, credPrefix: record?.credPrefix },
    });
  }

  /**
   * Disable every active credential for a solver (deregister / deactivate /
   * slash).  Revokes them in the database and propagates via pub/sub so all
   * replicas stop accepting them.
   *
   * @returns the total number of credentials disabled.
   */
  async disableAllForSolver(solverAddress: string): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    const credentials = await this.repo.listBySolver(solverAddress);
    let disabled = 0;
    for (const cred of credentials) {
      if (cred.revokedAt !== null) continue;
      await this.revokeCredential(cred.id, "solver-disabled");
      disabled += 1;
    }
    // The sweep is the authoritative safety net: it also catches credentials
    // created after the list above was read, which the loop cannot see. Its
    // `revokedAt: null` filter means it only matches rows the loop missed, so
    // the two counts are disjoint and sum to the true total.
    const swept = await this.repo.disableAllForSolver(solverAddress, nowSec);
    const total = disabled + swept;
    this.logger.log(`disabled ${total} credentials for solver=${solverAddress}`);
    return total;
  }

  /** List a solver's credentials (metadata only — never plaintext). */
  async listCredentials(solverAddress: string): Promise<SolverCredentialRecord[]> {
    return this.repo.listBySolver(solverAddress);
  }

  /** Whether a credential id is known-revoked on this replica. */
  isRevoked(credentialId: string): boolean {
    return this.revokedSet.has(credentialId);
  }

  /** Number of cached active credentials (for tests / metrics). */
  get cacheSize(): number {
    return this.activeCache.size;
  }

  private onRevocationMessage(msg: CredentialRevocationMessage): void {
    this.revokedSet.add(msg.credentialId);
    if (msg.credPrefix) this.activeCache.delete(msg.credPrefix);
  }

  private toPrincipal(record: SolverCredentialRecord): SolverCredentialPrincipal {
    return {
      credentialId: record.id,
      credPrefix: record.credPrefix,
      solverAddress: record.solverAddress,
      scopes: record.scopes,
      ipAllowlist: record.ipAllowlist,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.close().catch(() => undefined);
  }
}

export { SolverScope };
