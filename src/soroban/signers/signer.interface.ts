/**
 * Signer interface (issue #400 — Pluggable Remote Signer Backends)
 * ─────────────────────────────────────────────────────────────────
 * All signing backends implement this interface. Callers depend only on this
 * abstraction, not on any concrete implementation.
 *
 * Implementations:
 *   LocalKeypairSigner  — existing behaviour: key loaded from env / file.
 *   VaultTransitSigner  — HashiCorp Vault Transit (ed25519), key never in RAM.
 *
 * Selection is via the SIGNER_BACKEND env var (see env.validation.ts).
 * Production refuses to boot with LocalKeypairSigner unless
 * ALLOW_LOCAL_SIGNER_IN_PROD=true is explicitly set.
 */

import { FeeBumpTransaction, Transaction, xdr } from "@stellar/stellar-sdk";

export const SIGNER_TOKEN = Symbol("SIGNER");

/**
 * Minimal interface that every signing backend must satisfy.
 *
 * @remarks
 * `signTransaction` and `signAuthEntry` are async to accommodate remote
 * backends (Vault Transit, KMS) that make HTTP/gRPC calls.  Local
 * implementations may return synchronously by wrapping in `Promise.resolve`.
 */
export interface ISigner {
  /**
   * Returns the Ed25519 public key (Stellar G-address) that corresponds to
   * the private key held by this backend.
   */
  publicKey(): string;

  /**
   * Returns the Stellar network passphrase this signer was configured for.
   */
  networkPassphrase(): string;

  /**
   * Sign a classic or fee-bump transaction.  The backend appends its
   * signature to the transaction's decorated-signature list in-place and
   * also returns the transaction for convenient chaining.
   */
  signTransaction<T extends Transaction | FeeBumpTransaction>(transaction: T): Promise<T>;

  /**
   * Sign a Soroban auth entry for contract-authorisation flows.
   */
  signAuthEntry(entry: xdr.SorobanAuthorizationEntry): Promise<xdr.SorobanAuthorizationEntry>;
}
