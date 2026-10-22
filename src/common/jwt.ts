import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export interface JwtClaims {
  sub: string;
  exp?: number;
  nbf?: number;
  [claim: string]: unknown;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/**
 * Verifies an HS256 JWT (the token issued by the SEP-10 solver auth flow,
 * #442) and returns its claims, or null when the signature, algorithm,
 * `exp`/`nbf` or `sub` is invalid.
 */
export function verifyHs256Jwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): JwtClaims | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (head.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtClaims;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.exp === "number" && claims.exp <= nowSec) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Signs an HS256 JWT. Used by tests and by the SEP-10 issuer (#442). */
export function signHs256Jwt(claims: JwtClaims, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/**
 * Loads an Ed25519 private key for the SEP-10 session JWTs (issue #442).
 *
 * Accepts a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), a PEM whose newlines
 * were flattened to literal `\n` sequences (common in `.env` files and
 * container manifests), or the bare base64 DER body. Returns null when the
 * input is empty or is not a usable Ed25519 private key.
 */
export function loadEd25519PrivateKey(secret: string): KeyObject | null {
  const normalized = secret.trim().replace(/\\n/g, "\n");
  if (!normalized) return null;
  try {
    if (normalized.includes("PRIVATE KEY")) {
      return createPrivateKey(normalized);
    }
    // Bare base64 DER (PKCS#8) — decode and load directly. Re-wrapping into
    // PEM here used to emit a stray blank line before the END header, which
    // OpenSSL 3 rejects (`DECODER routines::unsupported`).
    const der = Buffer.from(normalized.replace(/\s+/g, ""), "base64");
    if (der.length === 0) return null;
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return null;
  }
}

/**
 * Derives the public verification key for an Ed25519 private key (issue #442).
 * Node derives the public key from any private key object, so the public half
 * of `SEP10_JWT_SIGNING_KEY` never needs its own configuration.
 */
export function ed25519PublicKeyFor(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}

/** A public Ed25519 key in JWKS form (RFC 8037 / RFC 7517). */
export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  use: "sig";
  alg: "EdDSA";
  kid: string;
}

/**
 * Exports an Ed25519 public key as a JWK for the JWKS endpoint (issue #712).
 *
 * The raw `x` coordinate comes straight from Node's JWK export rather than
 * hand-rolled DER parsing, and `kid` is a deterministic hash of `x` so it is
 * stable across restarts with the same signing key. Returns null when the key
 * is missing or is not an Ed25519 public key.
 */
export function ed25519JwkFor(publicKey: KeyObject | null | undefined): Ed25519Jwk | null {
  if (!publicKey) return null;
  try {
    const jwk = publicKey.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string };
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || !jwk.x) return null;
    const kid = createHash("sha256").update(jwk.x).digest("base64url");
    return { kty: "OKP", crv: "Ed25519", x: jwk.x, use: "sig", alg: "EdDSA", kid };
  } catch {
    return null;
  }
}

/**
 * Signs claims as an `alg: EdDSA` JWT with an Ed25519 private key — the token
 * issued by the SEP-10 solver auth flow (issue #442).
 */
export function signEddsaJwt(claims: JwtClaims, privateKey: KeyObject): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(cryptoSign(null, Buffer.from(`${header}.${payload}`), privateKey));
  return `${header}.${payload}.${signature}`;
}

/**
 * Verifies an EdDSA JWT (the short-lived session token issued by the SEP-10
 * flow, issue #442) and returns its claims, or null when the signature,
 * algorithm, `exp`/`nbf` or `sub` is invalid. Tokens signed with any other
 * algorithm are rejected, so an HS256 token can never satisfy this check.
 */
export function verifyEddsaJwt(
  token: string,
  publicKey: KeyObject,
  nowSec = Math.floor(Date.now() / 1000),
): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (head.alg !== "EdDSA") return null;
    const valid = cryptoVerify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    if (!valid) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtClaims;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.exp === "number" && claims.exp <= nowSec) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}
