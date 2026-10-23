import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures (issue #432).
 *
 * Every delivery carries
 *
 *   X-Vortex-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Signing the timestamp with the body lets a receiver reject replays: verify
 * the HMAC over the *raw* bytes received (before JSON parsing), then reject
 * when |now − t| exceeds a tolerance (5 minutes is the recommendation).
 * The scheme follows https://www.standardwebhooks.com/ in spirit; see
 * `docs/webhooks.md` for verification snippets.
 */
export const SIGNATURE_HEADER = "x-vortex-signature";
export const SIGNATURE_VERSION = "v1";
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Prefix of generated secrets; purely cosmetic, part of the secret value. */
export const SECRET_PREFIX = "whsec_";

/** A fresh 32-byte signing secret. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Hex HMAC-SHA256 over `${timestamp}.${body}`. */
export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/** The full `X-Vortex-Signature` header value. */
export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},${SIGNATURE_VERSION}=${computeSignature(secret, timestamp, body)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

/**
 * Verify a received signature header — the reference implementation of what
 * integrators should do. Multiple `v1=` entries are accepted (any match wins)
 * so a receiver keeps working while a secret is being rotated.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "malformed" };
  const parts = header.split(",").map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  const signatures = parts.filter((p) => p.startsWith(`${SIGNATURE_VERSION}=`)).map((p) => p.slice(3));
  if (!Number.isInteger(t) || signatures.length === 0) return { ok: false, reason: "malformed" };

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };

  const expected = Buffer.from(computeSignature(secret, t, body), "hex");
  for (const candidate of signatures) {
    if (!/^[0-9a-f]{64}$/.test(candidate)) continue;
    const given = Buffer.from(candidate, "hex");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
