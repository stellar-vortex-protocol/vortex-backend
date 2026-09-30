import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { AppConfig } from "../../config/configuration";
import { resolveClientIp } from "../../intents/ws/connection-state";
import { SolverCredentialService, SolverCredentialPrincipal } from "./solver-credential.service";
import { ipMatchesAllowlist } from "./ip-allowlist";

/** Injects the authenticated {@link SolverCredentialPrincipal} set by {@link SolverCredentialGuard}. */
export const CurrentSolverCredential = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SolverCredentialPrincipal | null =>
    ctx.switchToHttp().getRequest<Request & { solverCredential?: SolverCredentialPrincipal | null }>()
      .solverCredential ?? null,
);

type CredentialRequest = Request & { solverCredential?: SolverCredentialPrincipal | null };

/**
 * Resolves a presented solver credential to a principal (issue #443).
 *
 * The credential is read from `Authorization: Bearer` or `x-solver-credential`
 * and verified by {@link SolverCredentialService.resolveCredential}.  A missing
 * or invalid credential leaves `request.solverCredential` as `null` and, when
 * the route requires authentication, results in a 401.
 *
 * A credential that carries an IP allowlist is additionally bound to its
 * source address: a request arriving from outside the allowlist is rejected
 * with 403 even though the secret itself is valid. The allowlist is opt-in, so
 * a credential without one is unaffected.
 *
 * This guard only authenticates; scope enforcement is the job of
 * {@link ScopeGuard} via {@link RequireScope}.
 */
@Injectable()
export class SolverCredentialGuard implements CanActivate {
  private readonly trustProxyHops: number;

  constructor(
    private readonly credentials: SolverCredentialService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.trustProxyHops = config.get("ws", { infer: true }).trustProxyHops;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CredentialRequest>();
    const presented = this.extractCredential(req);
    const principal = presented ? await this.credentials.resolveCredential(presented) : null;

    if (principal && !this.ipAllowed(req, principal)) {
      // Deliberately not attached to the request: a caller outside the
      // allowlist must not be able to act on the credential's identity.
      req.solverCredential = null;
      throw new ForbiddenException(
        "Solver credential is not permitted from this source address",
      );
    }

    req.solverCredential = principal;
    return true;
  }

  private ipAllowed(req: Request, principal: SolverCredentialPrincipal): boolean {
    // No allowlist configured → the restriction is opt-in, not opt-out.
    if (!principal.ipAllowlist || principal.ipAllowlist.length === 0) return true;
    const ip = resolveClientIp(
      req.socket?.remoteAddress,
      req.headers?.["x-forwarded-for"],
      this.trustProxyHops,
    );
    return ipMatchesAllowlist(ip, principal.ipAllowlist);
  }

  private extractCredential(req: Request): string | null {
    const auth = req.headers?.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      if (token) return token;
    }
    const header = req.headers?.["x-solver-credential"];
    if (typeof header === "string" && header) return header;
    return null;
  }
}
