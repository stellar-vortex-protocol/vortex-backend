import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { AppConfig } from "../../config/configuration";
import { verifyHs256Jwt } from "../../common/jwt";

type JwtRequest = Request & { solverAddress?: string };

/**
 * Authenticates a solver-scoped credential request via a SEP-10 JWT
 * (issue #443).
 *
 * The JWT is read from `Authorization: Bearer`, verified with the shared
 * HS256 secret, and its `sub` must match the `:address` path parameter — a
 * solver may only mint credentials for its own on-chain identity.  The
 * verified address is attached to the request for the handler.
 */
@Injectable()
export class SolverJwtGuard implements CanActivate {
  constructor(config: ConfigService<AppConfig, true>) {
    this.jwtSecret = config.get("authJwtSecret", { infer: true });
  }

  private readonly jwtSecret: string;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<JwtRequest>();
    const address = context.switchToHttp().getRequest<{ params?: { address?: string } }>().params?.address ?? "";
    const presented = this.extractToken(req);
    if (!presented) {
      throw new UnauthorizedException("A valid SEP-10 JWT is required");
    }
    const claims = verifyHs256Jwt(presented, this.jwtSecret);
    if (!claims) {
      throw new UnauthorizedException("Invalid or expired SEP-10 JWT");
    }
    if (claims.sub !== address) {
      throw new ForbiddenException("JWT subject does not match the requested solver address");
    }
    req.solverAddress = address;
    return true;
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers?.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      if (token) return token;
    }
    return null;
  }
}
