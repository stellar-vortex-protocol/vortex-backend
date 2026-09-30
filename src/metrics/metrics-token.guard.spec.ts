import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { MetricsTokenGuard } from "./metrics-token.guard";

function makeContext(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader ? { authorization: authHeader } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("MetricsTokenGuard", () => {
  let guard: MetricsTokenGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    guard = new MetricsTokenGuard();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("no METRICS_TOKEN configured", () => {
    beforeEach(() => {
      delete process.env.METRICS_TOKEN;
    });

    it("allows unauthenticated access in development", () => {
      process.env.NODE_ENV = "development";
      expect(guard.canActivate(makeContext())).toBe(true);
    });

    it("allows unauthenticated access in test", () => {
      process.env.NODE_ENV = "test";
      expect(guard.canActivate(makeContext())).toBe(true);
    });

    it("denies access in production (fail-closed)", () => {
      process.env.NODE_ENV = "production";
      expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
    });
  });

  describe("METRICS_TOKEN configured", () => {
    beforeEach(() => {
      process.env.METRICS_TOKEN = "secret-token-abc";
    });

    it("allows a request with the correct bearer token", () => {
      expect(guard.canActivate(makeContext("Bearer secret-token-abc"))).toBe(true);
    });

    it("denies a request with the wrong bearer token", () => {
      expect(() => guard.canActivate(makeContext("Bearer wrong-token"))).toThrow(
        UnauthorizedException,
      );
    });

    it("denies a request with no Authorization header", () => {
      expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
    });

    it("denies a request with a non-Bearer scheme", () => {
      expect(() => guard.canActivate(makeContext("Basic secret-token-abc"))).toThrow(
        UnauthorizedException,
      );
    });

    it("works the same in production when token is set", () => {
      process.env.NODE_ENV = "production";
      expect(guard.canActivate(makeContext("Bearer secret-token-abc"))).toBe(true);
    });
  });
});
