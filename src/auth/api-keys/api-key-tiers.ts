/**
 * API key tier definitions (issue #441).
 *
 * Each tier selects a distributed rate-limit quota. The `public` tier is the
 * anonymous default — it matches the pre-existing global IP throttle
 * (100 req/min) so introducing tiered keys never weakens anonymous throttling.
 * Higher tiers are granted to authenticated API keys.
 *
 * Limits are per-credential (or per-IP for the public tier) and are enforced
 * by the Redis-backed distributed rate limiter with a bounded local fallback.
 */

export const API_KEY_TIERS = ["public", "integrator", "solver", "partner"] as const;

export type ApiKeyTier = (typeof API_KEY_TIERS)[number];

export interface TierLimit {
  /** Requests allowed per 60-second sliding window. */
  requestsPerMinute: number;
  /** Human-readable description for documentation and error messages. */
  description: string;
}

/**
 * Rate-limit quota per tier. The public tier equals the legacy global IP
 * limit (100/min) so anonymous behaviour is unchanged; every authenticated
 * tier is strictly higher.
 */
export const TIER_LIMITS: Record<ApiKeyTier, TierLimit> = {
  public: {
    requestsPerMinute: 100,
    description: "Anonymous / unauthenticated clients (per IP)",
  },
  integrator: {
    requestsPerMinute: 300,
    description: "Registered integrator API keys",
  },
  solver: {
    requestsPerMinute: 600,
    description: "Solver programmatic access",
  },
  partner: {
    requestsPerMinute: 2000,
    description: "High-volume partner API keys",
  },
};

/** The tier applied to requests that present no valid API key. */
export const DEFAULT_TIER: ApiKeyTier = "public";

/** Whether a string is a valid tier name. */
export function isApiKeyTier(value: unknown): value is ApiKeyTier {
  return typeof value === "string" && (API_KEY_TIERS as readonly string[]).includes(value);
}
