import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_SCOPE_KEY } from "./require-scope.decorator";
import { SolverCredentialService, SolverCredentialPrincipal } from "./solver-credential.service";

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
