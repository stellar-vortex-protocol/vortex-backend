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
}

const ROLE_RANK: Record<AdminRole, number> = { admin: 1, superadmin: 2 };

/** HTTP header carrying the admin secret. */
export const ADMIN_KEY_HEADER = "x-admin-key";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Parses ADMIN_API_KEYS ("id:role:secret,...") into hashed key records.
 * Format is enforced by env.validation.ts; malformed entries are skipped here.
 */
export function parseAdminApiKeys(raw: string): AdminKey[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [id, role, ...rest] = entry.split(":");
      const secret = rest.join(":");
      if (!id || !secret || (role !== "admin" && role !== "superadmin")) return [];
      return [{ id, role, secretHash: sha256(secret) } as AdminKey];
    });
}

/**
 * Resolves a presented secret to a principal using constant-time comparison.
 * Returns null when the secret is missing or matches no configured key.
 */
export function authenticateAdminKey(
  presented: string | undefined,
  keys: AdminKey[],
): AdminPrincipal | null {
  if (!presented) return null;
  const presentedHash = sha256(presented);
  let match: AdminKey | undefined;
  for (const key of keys) {
    // Compare against every key so timing does not reveal which one matched.
    if (timingSafeEqual(presentedHash, key.secretHash)) match = key;
  }
  return match ? { id: match.id, role: match.role } : null;
}

/** True when `principal` holds at least the `required` role. */
export function hasRole(principal: AdminPrincipal, required: AdminRole): boolean {
  return ROLE_RANK[principal.role] >= ROLE_RANK[required];
}
