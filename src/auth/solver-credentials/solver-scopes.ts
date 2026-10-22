/**
 * Scoped solver credential scopes (issue #443).
 *
 * Solver credentials are minted with an explicit set of scopes. Access is
 * deny-by-default: a credential may only perform an operation whose required
 * scope is present in its scope set. The {@link RequireScope} decorator and
 * {@link ScopeGuard} enforce this at the route layer.
 */

export const SOLVER_SCOPES = [
  "solver:read",
  "intents:read",
  "quote:respond",
  "intents:accept",
  "intents:fill",
  "solver:update",
  "solver:deregister",
] as const;

export type SolverScope = (typeof SOLVER_SCOPES)[number];

/** Whether a string is a valid scope. */
export function isSolverScope(value: unknown): value is SolverScope {
  return typeof value === "string" && (SOLVER_SCOPES as readonly string[]).includes(value);
}

/**
 * Scope enforcement matrix (issue #443).
 *
 * Maps each protected operation to the scope required to perform it. A
 * credential holding the listed scope may perform the operation; all other
 * operations are denied. This matrix is the single source of truth tested by
 * the scope enforcement matrix tests.
 */
export const SCOPE_REQUIREMENTS: Record<string, SolverScope> = {
  "solver:read": "solver:read",
  "intents:read": "intents:read",
  "quote:respond": "quote:respond",
  "intents:accept": "intents:accept",
  "intents:fill": "intents:fill",
  // Solver self-service profile management (issue #703).
  "solver:update": "solver:update",
  // Solver deregistration (issue #703). A credential's scopes are fixed at
  // creation/rotation time, so granting this to a long-lived automation
  // credential is a meaningful trust decision: deregistration is irreversible
  // for that registration epoch.
  "solver:deregister": "solver:deregister",
};

/** Whether `grantedScopes` satisfies the scope required for `operation`. */
export function scopeAllows(grantedScopes: readonly string[], operation: string): boolean {
  const required = SCOPE_REQUIREMENTS[operation];
  if (!required) return false; // unknown operation → deny by default
  return grantedScopes.includes(required);
}
