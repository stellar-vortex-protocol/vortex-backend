import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Seals webhook signing secrets at rest (issue #432).
 *
 * HMAC signing needs the plaintext secret at delivery time, so — unlike API
 * keys — it cannot be stored as a hash. It is sealed with AES-256-GCM under
 * `WEBHOOK_SECRET_ENCRYPTION_KEY` instead; a database dump alone does not
 * reveal any integrator's secret.
 *
 * Format: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`.
 */
export class WebhookSecretCipher {
  private readonly key: Buffer;

  /**
   * @param rawKey 32 bytes as hex (64 chars) or base64. Empty → a fixed
   *   development key; `env.validation.ts` makes the variable mandatory in
   *   production.
   */
  constructor(rawKey: string) {
    this.key = WebhookSecretCipher.parseKey(rawKey);
  }

  static parseKey(rawKey: string): Buffer {
    const trimmed = rawKey.trim();
    if (!trimmed) return createHash("sha256").update("vortex-dev-webhook-secret-key").digest();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY must be 32 bytes, hex- or base64-encoded");
  }

  seal(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || ciphertext === undefined) throw new Error("Unrecognised sealed secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}
