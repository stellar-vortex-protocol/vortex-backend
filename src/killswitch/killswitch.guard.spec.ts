import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  KillSwitchActiveException,
  KillSwitchGate,
  KillSwitchGuard,
} from "./killswitch.guard";
import { KILL_SWITCH_GUARD } from "./killswitch.guard.token";
import { KillSwitchService } from "./killswitch.service";
import { SwitchDecision } from "./killswitch.types";

const ALLOW: SwitchDecision = { paused: false, matched: null, matchedChain: [] };

function makeContext(
  metadata: Record<string, unknown> | undefined,
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  return {
    getHandler: () => handlerRef,
    getClass: () => classRef,
    switchToHttp: () => ({
      getRequest: () => ({ body, params }),
    }),
  } as unknown as ExecutionContext;
}

const handlerRef = () => undefined;
const classRef = class {};

function makeGuard(decision: SwitchDecision = ALLOW) {
  const killSwitch = { evaluateTarget: jest.fn().mockReturnValue(decision) };
  const reflector = {
    getAllAndOverride: jest.fn().mockImplementation((_key: string, targets: unknown[]) => {
      // The decorator stores metadata on the handler; the test applies it here.
      return targets === undefined ? undefined : appliedMetadata;
    }),
  };
  const guard = new KillSwitchGuard(
    killSwitch as unknown as KillSwitchService,
    reflector as unknown as Reflector,
  );
  return { guard, killSwitch, reflector };
}

let appliedMetadata: Record<string, unknown> | undefined;

describe("KillSwitchGuard", () => {
  beforeEach(() => {
    appliedMetadata = undefined;
  });

  describe("no metadata", () => {
    it("allows the request without consulting the service", () => {
      const { guard, killSwitch } = makeGuard();
      expect(guard.canActivate(makeContext(undefined))).toBe(true);
      expect(killSwitch.evaluateTarget).not.toHaveBeenCalled();
    });
  });

  describe("allowed writes", () => {
    it("permits the request when the decision is not paused", () => {
      appliedMetadata = { operation: "fill" };
      const { guard } = makeGuard(ALLOW);
      expect(guard.canActivate(makeContext(appliedMetadata))).toBe(true);
    });
  });

  describe("blocked writes", () => {
    const pausedDecision: SwitchDecision = {
      paused: true,
      matched: {
        scope: "chain",
        chain: "stellar",
        token: null,
        operation: null,
        active: true,
        reasonCode: "CHAIN_DEGRADED",
        reason: "RPC flapping",
        activatedBy: "alice",
        updatedAt: 1_700_000_000_000,
      },
      matchedChain: [],
    };

    it("throws a 503 carrying the reason code and scope", () => {
      appliedMetadata = { operation: "fill" };
      const { guard } = makeGuard(pausedDecision);

      let caught: KillSwitchActiveException | undefined;
      try {
        guard.canActivate(makeContext(appliedMetadata));
      } catch (err) {
        caught = err as KillSwitchActiveException;
      }

      expect(caught).toBeInstanceOf(KillSwitchActiveException);
      expect(caught!.getStatus()).toBe(503);
      expect(caught!.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);

      const body = caught!.getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "Killswitch active",
        reason: "CHAIN_DEGRADED",
        message: "RPC flapping",
        scope: "chain",
        chain: "stellar",
        activatedBy: "alice",
      });
    });

    it("honours a per-route Retry-After override", () => {
      appliedMetadata = { operation: "fill", retryAfterSeconds: 120 };
      const { guard } = makeGuard(pausedDecision);

      try {
        guard.canActivate(makeContext(appliedMetadata));
        fail("expected the guard to throw");
      } catch (err) {
        expect((err as KillSwitchActiveException).retryAfterSeconds).toBe(120);
      }
    });

    it("fails closed with a generic reason when the service has no match detail", () => {
      appliedMetadata = { operation: "fill" };
      const { guard } = makeGuard({ paused: true, matched: null, matchedChain: [] });

      try {
        guard.canActivate(makeContext(appliedMetadata));
        fail("expected the guard to throw");
      } catch (err) {
        const body = (err as KillSwitchActiveException).getResponse() as Record<string, unknown>;
        expect(body.reason).toBe("UNKNOWN");
        expect(body.scope).toBe("global");
      }
    });
  });

  describe("address resolution", () => {
    it("derives chain and token from the request body", () => {
      appliedMetadata = { operation: "create" };
      const { guard, killSwitch } = makeGuard(ALLOW);

      guard.canActivate(
        makeContext(appliedMetadata, {
          srcChain: "stellar",
          srcToken: { address: "USDC", symbol: "USDC" },
        }),
      );

      expect(killSwitch.evaluateTarget).toHaveBeenCalledWith({
        chain: "stellar",
        token: "USDC",
        operation: "create",
      });
    });

    it("accepts a token given as a plain string", () => {
      appliedMetadata = { operation: "create" };
      const { guard, killSwitch } = makeGuard(ALLOW);

      guard.canActivate(
        makeContext(appliedMetadata, { srcChain: "base", srcToken: "DAI" }),
      );

      expect(killSwitch.evaluateTarget).toHaveBeenCalledWith({
        chain: "base",
        token: "DAI",
        operation: "create",
      });
    });

    it("falls back to the symbol when a token object has no address", () => {
      appliedMetadata = { operation: "fill" };
      const { guard, killSwitch } = makeGuard(ALLOW);

      guard.canActivate(
        makeContext(appliedMetadata, { srcChain: "stellar", srcToken: { symbol: "XLM" } }),
      );

      expect(killSwitch.evaluateTarget).toHaveBeenCalledWith({
        chain: "stellar",
        token: "XLM",
        operation: "fill",
      });
    });

    it("prefers an explicit decorator chain over the body", () => {
      appliedMetadata = { operation: "onchain", chain: "stellar" };
      const { guard, killSwitch } = makeGuard(ALLOW);

      guard.canActivate(makeContext(appliedMetadata, { srcChain: "base" }));

      expect(killSwitch.evaluateTarget).toHaveBeenCalledWith({
        chain: "stellar",
        token: null,
        operation: "onchain",
      });
    });

    it("handles a request with no body and no params", () => {
      appliedMetadata = { operation: "accept" };
      const { guard, killSwitch } = makeGuard(ALLOW);

      guard.canActivate(makeContext(appliedMetadata, {}, {}));

      expect(killSwitch.evaluateTarget).toHaveBeenCalledWith({
        chain: null,
        token: null,
        operation: "accept",
      });
    });
  });

  describe("decorator", () => {
    it("stamps the metadata under the killswitch key", () => {
      const decorated = KillSwitchGate({ operation: "fill" });
      expect(decorated).toBeDefined();
      expect(KILL_SWITCH_GUARD).toBe("killswitch:gate");
    });
  });
});
