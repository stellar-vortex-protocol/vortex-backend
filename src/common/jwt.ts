import { createHmac, timingSafeEqual } from "node:crypto";

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
