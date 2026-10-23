import { createHash, timingSafeEqual } from "node:crypto";

/** Admin roles, ordered by privilege: a superadmin satisfies every admin check. */
export type AdminRole = "admin" | "superadmin";

/** Authenticated operator identity attached to a request by {@link AdminGuard}. */
export interface AdminPrincipal {
  id: string;
  role: AdminRole;
}

interface AdminKey extends AdminPrincipal {
  secretHash: Buffer;
  /** Epoch milliseconds after which the key no longer authenticates. */
  expiresAt?: number;
}

const ROLE_RANK: Record<AdminRole, number> = { admin: 1, superadmin: 2 };

/** HTTP header carrying the admin secret. */
export const ADMIN_KEY_HEADER = "x-admin-key";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Parses ADMIN_API_KEYS into hashed key records.
 *
 * Each comma-separated entry is either `id:role:secret` (valid indefinitely)
 * or `id:role:secret:expiresAtIso` (self-expiring). `expiresAtIso` must be a
 * valid ISO-8601 timestamp; entries whose expiry is malformed or already in
 * the past are dropped entirely, as if they were never configured.
 * Format is enforced by env.validation.ts; malformed entries are skipped here.
 */
export function parseAdminApiKeys(raw: string): AdminKey[] {
  const now = Date.now();
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [id, role, ...rest] = entry.split(":");
      if (!id || (role !== "admin" && role !== "superadmin")) return [];
      const secret = rest[0];
      if (!secret) return [];
      const rawExpiry = rest.length > 1 ? rest.slice(1).join(":") : undefined;
      let expiresAt: number | undefined;
      if (rawExpiry !== undefined) {
        const parsed = Date.parse(rawExpiry);
        if (Number.isNaN(parsed) || parsed <= now) return [];
        expiresAt = parsed;
      }
      return [{ id, role, secretHash: sha256(secret), expiresAt } as AdminKey];
    });
}

/**
 * Resolves a presented secret to a principal using constant-time comparison.
 * Returns null when the secret is missing, matches no configured key, or
 * matches a key whose `expiresAt` has passed — an expired key is treated
 * exactly like an unknown one so callers need no special-case handling.
 */
export function authenticateAdminKey(
  presented: string | undefined,
  keys: AdminKey[],
): AdminPrincipal | null {
  if (!presented) return null;
  const presentedHash = sha256(presented);
  const now = Date.now();
  let match: AdminKey | undefined;
  for (const key of keys) {
    // Compare against every key so timing does not reveal which one matched.
    if (timingSafeEqual(presentedHash, key.secretHash)) match = key;
  }
  if (!match) return null;
  if (match.expiresAt !== undefined && now >= match.expiresAt) return null;
  return { id: match.id, role: match.role };
}

/** True when `principal` holds at least the `required` role. */
export function hasRole(principal: AdminPrincipal, required: AdminRole): boolean {
  return ROLE_RANK[principal.role] >= ROLE_RANK[required];
}
