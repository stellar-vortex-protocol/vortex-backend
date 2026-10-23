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

describe("admin key expiry", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const RAW_WITH_EXPIRY = [
    `ops:admin:ops-secret-0123456789:${future}`,
    `temp:admin:temp-secret-0123456789:${past}`,
  ].join(",");

  it("authenticates a not-yet-expired key", () => {
    const keys = parseAdminApiKeys(RAW_WITH_EXPIRY);
    const ops = authenticateAdminKey("ops-secret-0123456789", keys);
    expect(ops).toEqual({ id: "ops", role: "admin" });
  });

  it("rejects an already-expired key exactly like a wrong secret", () => {
    const keys = parseAdminApiKeys(RAW_WITH_EXPIRY);
    expect(authenticateAdminKey("temp-secret-0123456789", keys)).toBeNull();
    expect(authenticateAdminKey("temp-secret-0123456789", keys)).toEqual(
      authenticateAdminKey("wrong", keys),
    );
  });

  it("guard rejects an expired key with the same 401 as a missing key", () => {
    const guard = new AdminGuard(new Reflector(), {
      get: () => RAW_WITH_EXPIRY,
    } as unknown as ConfigService<AppConfig, true>);
    expect(() => guard.canActivate(context("temp-secret-0123456789"))).toThrow(UnauthorizedException);
    expect(guard.canActivate(context("ops-secret-0123456789"))).toBe(true);
  });

  it("drops entries with malformed or past expiresAt at parse time", () => {
    const keys = parseAdminApiKeys(
      [
        "bad:admin:bad-secret-0123456789:not-a-date",
        `gone:admin:gone-secret-0123456789:${past}`,
        `ops:admin:ops-secret-0123456789:${future}`,
      ].join(","),
    );
    expect(keys.map((k) => k.id)).toEqual(["ops"]);
    expect(authenticateAdminKey("bad-secret-0123456789", keys)).toBeNull();
    expect(authenticateAdminKey("gone-secret-0123456789", keys)).toBeNull();
  });

  it("keeps 3-field entries without expiry working as before", () => {
    const keys = parseAdminApiKeys(RAW);
    expect(keys.map((k) => k.id)).toEqual(["ops", "root"]);
    expect(authenticateAdminKey("ops-secret-0123456789", keys)).toEqual({ id: "ops", role: "admin" });
  });
});
