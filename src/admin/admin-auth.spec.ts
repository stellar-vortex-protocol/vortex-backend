import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { authenticateAdminKey, hasRole, parseAdminApiKeys } from "./admin-auth";
import { AdminGuard } from "./admin.guard";

const RAW = "ops:admin:ops-secret-0123456789,root:superadmin:root-secret-0123456789";

function context(key: string | undefined, role?: string): ExecutionContext {
  const req: Record<string, unknown> = { header: () => key };
  const handler = () => undefined;
  if (role) Reflect.defineMetadata("vortex:admin-role", role, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("admin RBAC", () => {
  const keys = parseAdminApiKeys(RAW);
  const guard = new AdminGuard(new Reflector(), {
    get: () => RAW,
  } as unknown as ConfigService<AppConfig, true>);

  it("authenticates by secret and ranks superadmin above admin", () => {
    const ops = authenticateAdminKey("ops-secret-0123456789", keys)!;
    const root = authenticateAdminKey("root-secret-0123456789", keys)!;
    expect(ops).toEqual({ id: "ops", role: "admin" });
    expect(hasRole(ops, "superadmin")).toBe(false);
    expect(hasRole(root, "admin")).toBe(true);
    expect(authenticateAdminKey("wrong", keys)).toBeNull();
    expect(authenticateAdminKey(undefined, keys)).toBeNull();
  });

  it("guard rejects missing keys (401) and insufficient roles (403)", () => {
    expect(() => guard.canActivate(context(undefined))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context("ops-secret-0123456789", "superadmin"))).toThrow(ForbiddenException);
    expect(guard.canActivate(context("root-secret-0123456789", "superadmin"))).toBe(true);
    expect(guard.canActivate(context("ops-secret-0123456789"))).toBe(true);
  });
});
