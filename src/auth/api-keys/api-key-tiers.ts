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

/**
 * API key scopes (issue #699).
 *
 * Scopes are an opt-in capability restriction layered on top of tiers. A key
 * created with an empty `scopes` array is unrestricted (legacy behaviour); a
 * key created with one or more scopes may only call routes whose required
 * scope it holds. Routes without a mapped requirement are denied to scoped
 * keys (deny-by-default).
 *
 * This mirrors the pattern used for solver credentials in
 * `src/auth/solver-credentials/solver-scopes.ts`.
 */

export const API_KEY_SCOPES = [
  "admin:tokens:read",
  "admin:tokens:write",
  "datasets:read",
  "datasets:export",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Whether a string is a valid API key scope. */
export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * Route → required scope map.
 *
 * Keys are `"<METHOD> <path>"` using the same path templates declared on the
 * controllers. Only routes listed here are callable by scoped keys; every
 * other route is denied to scoped keys (deny-by-default). Unscoped keys
 * (empty `scopes`) are unaffected.
 */
export const API_KEY_SCOPE_REQUIREMENTS: Readonly<Record<string, ApiKeyScope>> = {
  "GET /tokens/admin": "admin:tokens:read",
  "POST /tokens/admin": "admin:tokens:write",
  "DELETE /tokens/admin/:id": "admin:tokens:write",
  "GET /datasets": "datasets:read",
  "GET /datasets/:id": "datasets:read",
  "GET /datasets/:id/export": "datasets:export",
};

/**
 * Build the lookup key used by {@link API_KEY_SCOPE_REQUIREMENTS}.
 */
export function apiKeyScopeRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Resolve the scope required for a route, or `undefined` when the route is
 * unmapped (which means scoped keys are denied).
 */
export function requiredScopeForRoute(
  method: string,
  path: string,
): ApiKeyScope | undefined {
  return API_KEY_SCOPE_REQUIREMENTS[apiKeyScopeRouteKey(method, path)];
}

/**
 * Whether the granted scopes permit the required scope.
 *
 * An empty `grantedScopes` array means unrestricted (legacy keys keep working).
 * A missing required scope (unmapped route) is always denied for scoped keys.
 */
export function apiKeyScopeAllows(
  grantedScopes: readonly string[] | undefined | null,
  requiredScope: ApiKeyScope | undefined,
): boolean {
  if (!grantedScopes || grantedScopes.length === 0) {
    return true;
  }
  if (!requiredScope) {
    return false;
  }
  return grantedScopes.includes(requiredScope);
}
