import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { KeyObject } from "node:crypto";
import { AppConfig } from "../../config/configuration";
import { verifyEddsaJwt, verifyHs256Jwt } from "../../common/jwt";
import { sep10JwtPublicKey } from "../sep10/sep10-keys";
import { Sep10DenylistStore } from "../sep10/denylist.store";

type JwtRequest = Request & { solverAddress?: string };

/**
 * Authenticates a solver-scoped credential request via a SEP-10 JWT
 * (issue #443/#442).
 *
 * The JWT is read from `Authorization: Bearer`: the 15-minute EdDSA token
 * issued by `POST /api/v1/auth/token` is verified first (`SEP10_JWT_SIGNING_KEY`),
 * falling back to the legacy HS256 token (`AUTH_JWT_SECRET`) so existing
 * deployments keep working. Its `sub` must match the `:address` path
 * parameter — a solver may only mint credentials for its own on-chain
 * identity. The verified address is attached to the request for the handler.
 */
@Injectable()
export class SolverJwtGuard implements CanActivate {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly denylist: Sep10DenylistStore,
  ) {
    this.jwtSecret = config.get("authJwtSecret", { infer: true });
    this.sep10PublicKey = sep10JwtPublicKey(
      config.get("stellar.signerSecretKey", { infer: true }),
      config.get("sep10JwtSigningKey", { infer: true }),
    );
  }

  private readonly jwtSecret: string;
  private readonly sep10PublicKey: KeyObject | null;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<JwtRequest>();
    const address = context.switchToHttp().getRequest<{ params?: { address?: string } }>().params?.address ?? "";
    const presented = this.extractToken(req);
    if (!presented) {
      throw new UnauthorizedException("A valid SEP-10 JWT is required");
    }
    const claims =
      (this.sep10PublicKey ? verifyEddsaJwt(presented, this.sep10PublicKey) : null) ??
      verifyHs256Jwt(presented, this.jwtSecret);
    if (!claims) {
      throw new UnauthorizedException("Invalid or expired SEP-10 JWT");
    }
    if (claims.jti && (await this.denylist.isRevoked(claims.jti))) {
      throw new UnauthorizedException("SEP-10 JWT has been revoked");
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
