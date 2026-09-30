import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NextFunction, Request, Response } from "express";
import { AppConfig } from "../config/configuration";
import {
  ADMIN_KEY_HEADER,
  AdminPrincipal,
  AdminRole,
  authenticateAdminKey,
  hasRole,
  parseAdminApiKeys,
} from "./admin-auth";

const ADMIN_ROLE_KEY = "vortex:admin-role";

type AdminRequest = Request & { admin?: AdminPrincipal };

/** Declares the minimum admin role for a controller or handler guarded by {@link AdminGuard}. */
export const RequireAdminRole = (role: AdminRole) => SetMetadata(ADMIN_ROLE_KEY, role);

/** Injects the authenticated {@link AdminPrincipal} set by {@link AdminGuard}. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminPrincipal =>
    ctx.switchToHttp().getRequest<AdminRequest>().admin as AdminPrincipal,
);

/**
 * Admin RBAC: authenticates the `x-admin-key` header against ADMIN_API_KEYS
 * and enforces the role declared via {@link RequireAdminRole} (default "admin").
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly keys;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService<AppConfig, true>,
  ) {
    this.keys = parseAdminApiKeys(config.get("adminApiKeys", { infer: true }) ?? "");
  }

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<AdminRole>(ADMIN_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? "admin";
    const req = context.switchToHttp().getRequest<AdminRequest>();
    req.admin = authorize(req.header(ADMIN_KEY_HEADER), this.keys, required);
    return true;
  }
}

/** Express middleware equivalent of {@link AdminGuard}, for non-Nest routers (Bull Board). */
export function adminAuthMiddleware(rawKeys: string, required: AdminRole = "admin") {
  const keys = parseAdminApiKeys(rawKeys);
  return (req: AdminRequest, res: Response, next: NextFunction) => {
    try {
      req.admin = authorize(req.header(ADMIN_KEY_HEADER), keys, required);
      next();
    } catch (err) {
      const status = err instanceof ForbiddenException ? 403 : 401;
      res.status(status).json({ statusCode: status, message: (err as Error).message });
    }
  };
}

function authorize(
  presented: string | undefined,
  keys: ReturnType<typeof parseAdminApiKeys>,
  required: AdminRole,
): AdminPrincipal {
  const principal = authenticateAdminKey(presented, keys);
  if (!principal) throw new UnauthorizedException("Missing or invalid admin key");
  if (!hasRole(principal, required)) throw new ForbiddenException(`Requires ${required} role`);
  return principal;
}
