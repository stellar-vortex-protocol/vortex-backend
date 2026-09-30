import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Shared secure-hashing primitives for API keys (#441) and scoped solver
 * credentials (#443).
 *
 * Both credential types follow the same storage model:
 *   - The plaintext secret is generated with a cryptographically secure RNG.
 *   - Only its SHA-256 hash (hex) is persisted — never the plaintext.
 *   - A non-secret `prefix` (first 8 chars) is stored alongside the hash as a
 *     lookup handle for listings and rate-limit trackers.
 *   - Verification hashes the presented secret and compares in constant time.
 *
 * The prefix is deliberately NOT a truncation of the hash — it is taken from
 * the plaintext so operators can recognise a key without revealing it, and so
 * rate-limit trackers can be scoped per credential.
 */

/** Number of random bytes in a generated secret (32 bytes = 256 bits). */
const SECRET_BYTES = 32;

/** Length of the non-secret lookup prefix. */
export const CREDENTIAL_PREFIX_LENGTH = 8;

/** A generated credential: the plaintext (shown once) and its storage handle. */
export interface GeneratedCredential {
  /** Full plaintext secret. Returned ONCE at creation — never persisted. */
  plaintext: string;
  /** Non-secret lookup prefix (first 8 chars of the plaintext). */
  prefix: string;
  /** SHA-256 hash of the plaintext (hex) — what gets stored. */
  hash: string;
}

/** Generate a cryptographically secure random secret (URL-safe base64). */
export function generateCredentialSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/** SHA-256 hash of a secret, hex-encoded. */
export function hashCredential(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Generate a new credential and derive its storage handle in one step.
 * The plaintext is shown to the caller exactly once; only `prefix` and `hash`
 * should be persisted.
 */
export function generateCredential(): GeneratedCredential {
  const plaintext = generateCredentialSecret();
  return {
    plaintext,
    prefix: plaintext.slice(0, CREDENTIAL_PREFIX_LENGTH),
    hash: hashCredential(plaintext),
  };
}

/**
 * Constant-time verification of a presented secret against a stored hash.
 *
 * Both digests are compared as fixed-length buffers via {@link timingSafeEqual}
 * so the comparison time does not leak how many leading bytes matched. The
 * presented secret is hashed first (SHA-256) so the comparison is over
 * equal-length digests regardless of input length.
 */
export function verifyCredential(secret: string, expectedHash: string): boolean {
  const presented = Buffer.from(hashCredential(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Constant-time check that a presented secret's prefix matches the stored
 * prefix. Used to cheaply reject obviously-wrong credentials before hashing.
 */
export function verifyPrefix(secret: string, expectedPrefix: string): boolean {
  const presented = Buffer.from(secret.slice(0, expectedPrefix.length), "utf8");
  const expected = Buffer.from(expectedPrefix, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
