import { SetMetadata } from "@nestjs/common";

/** Metadata key under which the required scope is stored. */
export const REQUIRE_SCOPE_KEY = "vortex:require-scope";

/**
 * Declares the scope required to call a solver-credential-protected route
 * (issue #443).
 *
 * Used together with {@link ScopeGuard}, which reads this metadata and denies
 * the request when the authenticated credential does not hold the scope.
 * Access is deny-by-default: a route without this decorator is not protected
 * by scope, and a credential without the required scope is always rejected.
 *
 * @example
 *   \@RequireScope("intents:accept")
 *   \@Post(":id/accept")
 *   async accept() { ... }
 */
export const RequireScope = (scope: string) => SetMetadata(REQUIRE_SCOPE_KEY, scope);
