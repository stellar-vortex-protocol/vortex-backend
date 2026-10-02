/**
 * SignerService (issue #400 — refactored)
 * ─────────────────────────────────────────
 * Facade that delegates all signing operations to the injected ISigner backend
 * (LocalKeypairSigner or VaultTransitSigner).  Existing callers continue to
 * use SignerService unchanged — they do not need to know which backend is
 * active.
 *
 * Sequence-number management lives here (not in the backend) because it is
 * network-state rather than key-material.  The in-process lock and sequence
 * cache are independent of the signing implementation.
 *
 * The raw secret key is no longer held by this service — it is owned
 * exclusively by LocalKeypairSigner (and never exists in memory at all when
 * VaultTransitSigner is used).  The toString / toJSON / inspect overrides
 * here therefore only report the active backend name, never key material.
 */

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { FeeBumpTransaction, Keypair, Transaction, xdr } from "@stellar/stellar-sdk";
import { SorobanService } from "./soroban.service";
import { ISigner, SIGNER_TOKEN } from "./signers/signer.interface";

const REDACTED = "[redacted]";

@Injectable()
export class SignerService {
  private readonly logger = new Logger(SignerService.name);

  // Chains sequence acquisitions so they run one at a time, in call order.
  private sequenceLock: Promise<void> = Promise.resolve();
  private cachedSequence: bigint | null = null;

  constructor(
    @Inject(SIGNER_TOKEN) private readonly backend: ISigner,
    private readonly sorobanService: SorobanService,
  ) {}

  // ── ISigner delegation ────────────────────────────────────────────────────

  /** Returns the signing account's Stellar public key (G-address). */
  getPublicKey(): string {
    return this.backend.publicKey();
  }

  /** Returns the Stellar network passphrase this service was configured for. */
  getNetworkPassphrase(): string {
    return this.backend.networkPassphrase();
  }

  /**
   * Sign a transaction.  Delegates to the active backend.
   *
   * @deprecated Prefer `withNextSequence` for new Soroban transaction submissions.
   */
  async sign<T extends Transaction | FeeBumpTransaction>(transaction: T): Promise<T> {
    return this.backend.signTransaction(transaction);
  }

  /**
   * Sign a Soroban auth entry.  Delegates to the active backend.
   */
  async signAuthEntry(entry: xdr.SorobanAuthorizationEntry): Promise<xdr.SorobanAuthorizationEntry> {
    return this.backend.signAuthEntry(entry);
  }

  /** Whether a signing key has been configured.  False in dev/test by default. */
  isConfigured(): boolean {
    try {
      return this.backend.publicKey().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * The signing keypair when the backend can expose it (fee-bump
   * construction, issue #386). `undefined` for remote backends — key
   * material never leaves them, so fee escalation is unavailable there.
   */
  getFeeSourceKeypair(): Keypair | undefined {
    try {
      return this.backend.feeSourceKeypair?.();
    } catch {
      return undefined;
    }
  }

  // ── Sequence-number management ────────────────────────────────────────────

  /**
   * Runs `fn` with the next sequence number for the signing account, holding
   * an in-process lock for the duration so no concurrent caller gets the same
   * sequence number.
   *
   * The sequence is fetched from the network once and cached; subsequent calls
   * increment the cached value locally.  If `fn` throws the cache is dropped
   * so the next call re-syncs from the network rather than drifting.
   */
  async withNextSequence<T>(fn: (sequence: string) => Promise<T>): Promise<T> {
    let releaseLock!: () => void;
    const previous = this.sequenceLock;
    this.sequenceLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;

    try {
      const sequence = await this.nextSequence();
      return await fn(sequence);
    } catch (err) {
      this.cachedSequence = null;
      throw err;
    } finally {
      releaseLock();
    }
  }

  private async nextSequence(): Promise<string> {
    if (this.cachedSequence === null) {
      const account = await this.sorobanService.getAccount(this.getPublicKey());
      this.cachedSequence = BigInt(account.sequenceNumber());
    }
    this.cachedSequence += 1n;
    return this.cachedSequence.toString();
  }

  // ── Redaction guarantees ──────────────────────────────────────────────────

  toString(): string {
    return `SignerService(backend=${this.backend.constructor.name}, publicKey=${this.isConfigured() ? this.getPublicKey() : "unconfigured"}, secretKey=${REDACTED})`;
  }

  toJSON(): unknown {
    return {
      backend: this.backend.constructor.name,
      publicKey: this.isConfigured() ? this.getPublicKey() : null,
      secretKey: REDACTED,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
