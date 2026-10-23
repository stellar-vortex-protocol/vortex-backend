import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_SCOPE_KEY } from "./require-scope.decorator";
import { SolverCredentialService, SolverCredentialPrincipal } from "./solver-credential.service";
import { ApiKeyRecord } from "../api-keys/api-key.service";
import { API_KEY_SCOPE_KEY } from "../api-keys/require-api-key-scope.decorator";
import { resolveRequiredApiKeyScope } from "../api-keys/api-key-scopes";

/**
 * Enforces the scope declared by {@link RequireScope} (issue #443).
 *
 * Reads the required scope from the route metadata and checks it against the
 * authenticated credential's scopes.  Access is deny-by-default:
 *   - No authenticated credential → 403.
 *   - Credential lacks the required scope → 403.
 *   - Unknown operation (no scope requirement mapped) → 403.
 *
 * This guard must run after {@link SolverCredentialGuard}, which populates the
 * principal.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly credentials: SolverCredentialService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>(REQUIRE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true; // route does not require a specific scope

    const req = context.switchToHttp().getRequest<{ solverCredential?: SolverCredentialPrincipal | null }>();
    const principal = req.solverCredential ?? null;
    if (!principal) {
      throw new ForbiddenException("A valid solver credential is required for this operation");
    }
    if (!this.credentials.scopeAllows(principal, required)) {
      throw new ForbiddenException(`Solver credential lacks the required scope: ${required}`);
    }
    return true;
  }
}

/**
 * Enforces per-key API-key scopes (issue #699).
 *
 * Runs after {@link TieredThrottleGuard}, which resolves the API key and
 * attaches the record to `req.apiKeyRecord`.  Behaviour:
 *   - No resolved API key (public tier) → never scope-checked, allowed.
 *   - Key with an empty `scopes` array → unrestricted (legacy behaviour).
 *   - Key with explicit scopes → the required scope (from
 *     `@RequireApiKeyScope(...)` metadata or the route→scope map) must be
 *     present, otherwise 403.
 *   - Scoped key on an unmapped route → 403 (deny-by-default).
 *
 * Expired/revoked keys never reach this guard: they fail at resolution.
 */
@Injectable()
export class ApiKeyScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ apiKeyRecord?: ApiKeyRecord | null }>();
    const record = req.apiKeyRecord ?? null;
    if (!record) return true; // public tier: tiered only, never scope-checked

    const scopes = record.scopes ?? [];
    if (scopes.length === 0) return true; // empty scopes = unrestricted

    const required =
      this.reflector.getAllAndOverride<string>(API_KEY_SCOPE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? resolveRequiredApiKeyScope(context.getClass(), context.getHandler());

    if (!required) {
      throw new ForbiddenException(
        "This API key is scoped and the requested route is not covered by any API key scope",
      );
    }
    if (!scopes.includes(required)) {
      throw new ForbiddenException(`API key lacks the required scope: ${required}`);
    }
    return true;
  }
}
