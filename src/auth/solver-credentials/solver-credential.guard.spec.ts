import { ForbiddenException, ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { AppConfig } from "../../config/configuration";
import { SolverCredentialGuard } from "./solver-credential.guard";
import { ScopeGuard } from "./scope.guard";
import { REQUIRE_SCOPE_KEY } from "./require-scope.decorator";
import { SOLVER_SCOPES } from "./solver-scopes";
import type { SolverCredentialPrincipal, SolverCredentialService } from "./solver-credential.service";

const SOLVER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZAOKV6LTOTSGVYZWLXW3ZRBMR5C5";

function config(trustProxyHops = 1): ConfigService<AppConfig, true> {
  return {
    get: (key: keyof AppConfig) =>
      key === "ws" ? ({ trustProxyHops } as AppConfig["ws"]) : undefined,
  } as unknown as ConfigService<AppConfig, true>;
}

function principal(overrides: Partial<SolverCredentialPrincipal> = {}): SolverCredentialPrincipal {
  return {
    credentialId: "cred-1",
    credPrefix: "abcdefgh",
    solverAddress: SOLVER,
    scopes: ["solver:read"],
    ipAllowlist: null,
    ...overrides,
  };
}

/** A service stub that resolves one presented secret to one principal. */
function credentialsReturning(result: SolverCredentialPrincipal | null): SolverCredentialService {
  return { resolveCredential: jest.fn(async () => result) } as unknown as SolverCredentialService;
}

/** Stable stand-ins so a Reflector call can be compared by identity. */
const HANDLER = function handler(): void {};
const CONTROLLER = class TestController {};

function context(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    // Reflector-based guards read route metadata through these.
    getHandler: () => HANDLER,
    getClass: () => CONTROLLER,
  } as unknown as ExecutionContext;
}

function request(headers: Record<string, unknown>, remoteAddress = "203.0.113.7") {
  return { headers, socket: { remoteAddress }, solverCredential: undefined as unknown };
}

describe("SolverCredentialGuard (#443)", () => {
  describe("credential extraction", () => {
    it("reads the credential from the Authorization: Bearer header", async () => {
      const p = principal();
      const service = credentialsReturning(p);
      const guard = new SolverCredentialGuard(service, config());
      const req = request({ authorization: "Bearer presented-credential-value" });

      await guard.canActivate(context(req));

      expect(service.resolveCredential).toHaveBeenCalledWith("presented-credential-value");
      expect(req.solverCredential).toEqual(p);
    });

    it("reads the credential from x-solver-credential", async () => {
      const service = credentialsReturning(principal());
      const guard = new SolverCredentialGuard(service, config());
      const req = request({ "x-solver-credential": "presented-credential-value" });

      await guard.canActivate(context(req));

      expect(service.resolveCredential).toHaveBeenCalledWith("presented-credential-value");
    });

    it("leaves the principal null when no credential is presented", async () => {
      const service = credentialsReturning(principal());
      const guard = new SolverCredentialGuard(service, config());
      const req = request({});

      await guard.canActivate(context(req));

      expect(service.resolveCredential).not.toHaveBeenCalled();
      expect(req.solverCredential).toBeNull();
    });

    it("leaves the principal null when the credential does not resolve", async () => {
      const guard = new SolverCredentialGuard(credentialsReturning(null), config());
      const req = request({ authorization: "Bearer bad-credential-value" });

      // The guard authenticates but does not authorise: an invalid credential
      // must not throw here, so public routes stay reachable and @RequireScope
      // produces the 403.
      await expect(guard.canActivate(context(req))).resolves.toBe(true);
      expect(req.solverCredential).toBeNull();
    });
  });

  describe("IP allowlist enforcement", () => {
    it("allows a request from inside the allowlist", async () => {
      const p = principal({ ipAllowlist: ["203.0.113.7"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config());
      const req = request({ authorization: "Bearer presented-credential-value" });

      await expect(guard.canActivate(context(req))).resolves.toBe(true);
      expect(req.solverCredential).toEqual(p);
    });

    it("rejects a request from outside the allowlist even with a valid secret", async () => {
      const p = principal({ ipAllowlist: ["198.51.100.1"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config());
      const req = request({ authorization: "Bearer presented-credential-value" }, "203.0.113.7");

      await expect(guard.canActivate(context(req))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("does not attach the principal to a rejected request", async () => {
      // Otherwise a later guard in the chain could still read the identity off
      // the request object and act on it.
      const p = principal({ ipAllowlist: ["198.51.100.1"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config());
      const req = request({ authorization: "Bearer presented-credential-value" }, "203.0.113.7");

      await guard.canActivate(context(req)).catch(() => undefined);

      expect(req.solverCredential).toBeNull();
    });

    it("accepts any source when no allowlist is configured", async () => {
      for (const allowlist of [null, []]) {
        const p = principal({ ipAllowlist: allowlist });
        const guard = new SolverCredentialGuard(credentialsReturning(p), config());
        const req = request({}, "198.51.100.99");

        await expect(guard.canActivate(context(req))).resolves.toBe(true);
      }
    });

    it("supports a CIDR range in the allowlist", async () => {
      const p = principal({ ipAllowlist: ["203.0.113.0/24"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config());
      const req = request({}, "203.0.113.200");

      await expect(guard.canActivate(context(req))).resolves.toBe(true);
    });

    it("rejects an address outside a CIDR range", async () => {
      const p = principal({ ipAllowlist: ["203.0.113.0/24"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config());
      const req = request({ authorization: "Bearer presented-credential-value" }, "203.0.114.1");

      await expect(guard.canActivate(context(req))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("evaluates the allowlist against the trusted proxy hop, not the spoofable header", async () => {
      const p = principal({ ipAllowlist: ["198.51.100.4"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config(1));
      // The client claims to be allowlisted; the real peer is not. With one
      // trusted hop the socket address is authoritative, so the claim is ignored.
      const req = request(
        { authorization: "Bearer presented-credential-value", "x-forwarded-for": "198.51.100.4, 203.0.113.7" },
        "203.0.113.7",
      );

      await expect(guard.canActivate(context(req))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("ignores X-Forwarded-For entirely when no proxy is trusted", async () => {
      const p = principal({ ipAllowlist: ["203.0.113.7"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config(0));
      const req = request(
        { authorization: "Bearer presented-credential-value", "x-forwarded-for": "198.51.100.4" },
        "203.0.113.7",
      );

      await expect(guard.canActivate(context(req))).resolves.toBe(true);
    });

    it("fails closed when the allowlist is set but the peer address is unknown", async () => {
      const p = principal({ ipAllowlist: ["203.0.113.7"] });
      const guard = new SolverCredentialGuard(credentialsReturning(p), config());
      const req = { headers: { authorization: "Bearer presented-credential-value" }, socket: {} };

      await expect(guard.canActivate(context(req))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe("ScopeGuard (#443)", () => {
  /** A Reflector stub that returns a fixed required-scope value. */
  function reflectorReturning(required: string | undefined): Reflector {
    return {
      getAllAndOverride: jest.fn(() => required),
    } as unknown as Reflector;
  }

  function scopeService(): SolverCredentialService {
    return {
      scopeAllows: (p: SolverCredentialPrincipal | null, operation: string) =>
        !!p && p.scopes.includes(operation),
    } as unknown as SolverCredentialService;
  }

  function scopedRequest(p: SolverCredentialPrincipal | null) {
    return { headers: {}, socket: {}, solverCredential: p };
  }

  it("allows a route with no @RequireScope through untouched", () => {
    const guard = new ScopeGuard(reflectorReturning(undefined), scopeService());
    expect(guard.canActivate(context(scopedRequest(null)))).toBe(true);
  });

  it("denies an unauthenticated request to a scoped route", () => {
    const guard = new ScopeGuard(reflectorReturning("intents:accept"), scopeService());

    expect(() => guard.canActivate(context(scopedRequest(null)))).toThrow(ForbiddenException);
  });

  it("denies a credential that lacks the required scope", () => {
    const guard = new ScopeGuard(reflectorReturning("intents:fill"), scopeService());

    expect(() =>
      guard.canActivate(context(scopedRequest(principal({ scopes: ["solver:read"] })))),
    ).toThrow(/lacks the required scope: intents:fill/);
  });

  it("allows a credential that holds the required scope", () => {
    const guard = new ScopeGuard(reflectorReturning("intents:fill"), scopeService());

    expect(
      guard.canActivate(context(scopedRequest(principal({ scopes: ["intents:fill"] })))),
    ).toBe(true);
  });

  it("denies an unknown required scope even for a credential holding many scopes", () => {
    const guard = new ScopeGuard(
      reflectorReturning("intents:teleport"),
      scopeService(),
    );

    expect(() =>
      guard.canActivate(context(scopedRequest(principal({ scopes: [...SOLVER_SCOPES] })))),
    ).toThrow(ForbiddenException);
  });

  it("reads the requirement from the route handler, then the class", () => {
    const reflector = reflectorReturning("solver:read");
    const guard = new ScopeGuard(reflector, scopeService());
    const ctx = context(scopedRequest(principal()));

    guard.canActivate(ctx);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(REQUIRE_SCOPE_KEY, [
      HANDLER,
      CONTROLLER,
    ]);
  });

  it("enforces the full scope matrix through the guard", () => {
    for (const required of SOLVER_SCOPES) {
      const guard = new ScopeGuard(reflectorReturning(required), scopeService());

      // Holding exactly the required scope passes.
      expect(
        guard.canActivate(context(scopedRequest(principal({ scopes: [required] })))),
      ).toBe(true);

      // Holding anything else fails.
      const others = SOLVER_SCOPES.filter((s) => s !== required);
      for (const other of others) {
        expect(() =>
          guard.canActivate(context(scopedRequest(principal({ scopes: [other] })))),
        ).toThrow(ForbiddenException);
      }
    }
  });
});
