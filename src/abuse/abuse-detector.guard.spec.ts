/**
 * AbuseDetectorGuard + AccountAgeService wiring (issue #602): the guard asks
 * for the account age on intent creation and the real scorer turns it into a
 * `new_address` signal.
 */

import { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/configuration";
import { AbuseDetectorGuard } from "./abuse-detector.guard";
import { AbuseScoreService } from "./abuse-score.service";
import { AccountAgeService } from "./account-age.service";
import { AllowlistService } from "./allowlist.service";
import { AbuseScore } from "./abuse.types";

/** Redis stand-in with empty counters, so only the account-age rule can fire. */
const quietRedis = {
  zcount: async () => 0,
  zrangebyscore: async () => [],
  pipeline() {
    const chain = {
      zadd: () => chain,
      zremrangebyscore: () => chain,
      expire: () => chain,
      lpush: () => chain,
      ltrim: () => chain,
      set: () => chain,
      exec: async () => [],
    };
    return chain;
  },
  disconnect: () => undefined,
};

function config(): ConfigService<AppConfig, true> {
  return { get: () => "redis://localhost:6379" } as unknown as ConfigService<AppConfig, true>;
}

function httpContext(body: Record<string, unknown>, path = "/api/v1/intents"): ExecutionContext {
  const req = { body, path, method: "POST", headers: {}, ip: "203.0.113.7" };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function setup(ageFor: (address: string) => Promise<number | undefined>) {
  const scorer = new AbuseScoreService(config());
  (scorer as unknown as { redis: typeof quietRedis }).redis = quietRedis;
  const scored: AbuseScore[] = [];
  const realScore = scorer.score.bind(scorer);
  jest.spyOn(scorer, "score").mockImplementation(async (ctx, allowlisted) => {
    const result = await realScore(ctx, allowlisted);
    scored.push(result);
    return result;
  });

  const lookup = jest.fn(ageFor);
  const accountAge = { getAccountAgeSeconds: lookup } as unknown as AccountAgeService;
  const allowlist = { isAllowlisted: () => false } as unknown as AllowlistService;
  const guard = new AbuseDetectorGuard(scorer, allowlist, undefined, accountAge);
  return { guard, scorer, scored, lookup };
}

describe("AbuseDetectorGuard account age", () => {
  const user = Keypair.random().publicKey();
  const body = { user, srcAmount: "10000000", srcToken: { priceUSD: 1 }, srcTokenDecimals: 6 };

  it("fires new_address for a freshly funded account", async () => {
    const { guard, scored, lookup } = setup(async () => 30);
    await expect(guard.canActivate(httpContext(body))).resolves.toBe(true); // 15 points → still "pass"
    expect(lookup).toHaveBeenCalledWith(user); // original case, not lower-cased
    expect(scored[0].signals.map((s) => s.signal)).toEqual(["new_address"]);
    expect(scored[0].total).toBe(15);
  });

  it("fires new_address for an account that does not exist on-chain yet", async () => {
    const { guard, scored } = setup(async () => 0);
    await guard.canActivate(httpContext(body));
    expect(scored[0].signals.map((s) => s.signal)).toContain("new_address");
  });

  it("does not fire for an account older than minAgeSeconds", async () => {
    const { guard, scored } = setup(async () => 30 * 86_400);
    await guard.canActivate(httpContext(body));
    expect(scored[0].signals).toEqual([]);
  });

  it("stays silent and lets the request through when the lookup is unavailable", async () => {
    const { guard, scored } = setup(async () => undefined);
    await expect(guard.canActivate(httpContext(body))).resolves.toBe(true);
    expect(scored[0].signals).toEqual([]);
  });

  it("only looks up on intent creation", async () => {
    const { guard, lookup } = setup(async () => 0);
    await guard.canActivate(httpContext({ user, actor: user }, "/api/v1/intents/abc/cancel"));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("skips the lookup while the new_address rule is disabled", async () => {
    const { guard, scorer, lookup } = setup(async () => 0);
    await scorer.updateRule("new_address", { enabled: false });
    await guard.canActivate(httpContext(body));
    expect(lookup).not.toHaveBeenCalled();
  });
});
