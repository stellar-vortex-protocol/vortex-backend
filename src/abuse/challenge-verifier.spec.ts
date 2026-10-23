/**
 * ChallengeVerifier and the guard's `challenge` branch (issue #606).
 *
 * The captcha provider is mocked at the egress client, so these tests cover
 * the request we send and how each provider answer is treated:
 *  - a valid PoW nonce alone, or a valid captcha token alone, clears the challenge
 *  - an invalid token, provider outage, timeout or garbage answer never passes
 *  - with captcha disabled the header is ignored and PoW is still required
 *  - the raw captcha token never reaches a log line
 */

import { ConfigService } from "@nestjs/config";
import { ExecutionContext, HttpException, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { CAPTCHA_VERIFY_URLS, ChallengeVerifier } from "./challenge-verifier";
import { AbuseDetectorGuard } from "./abuse-detector.guard";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import type { AppConfig } from "../config/configuration";
import type { EgressResponse, HttpEgressService } from "../common/http-egress";
import { findSensitiveKeyMaterial } from "../soroban/redaction";

const TOKEN = "P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.captcha-token-under-test";

function config(provider: string, secret = "server-secret", timeoutMs = 200): ConfigService<AppConfig, true> {
  return {
    get: (key: string) =>
      key === "abuse"
        ? { allowlistPubsub: "memory", allowlistRefreshMs: 0, captcha: { provider, secret, timeoutMs } }
        : undefined,
  } as unknown as ConfigService<AppConfig, true>;
}

function reply(statusCode: number, body: unknown): EgressResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { statusCode, headers: {}, body: text, bodyBytes: text.length, finalUrl: "", ipUsed: "" };
}

function egressMock(impl: () => Promise<EgressResponse>) {
  const fetch = jest.fn(impl);
  return { egress: { fetch } as unknown as HttpEgressService, fetch };
}

function validPowNonce(difficulty = 4): string {
  for (let i = 0; ; i++) {
    const nonce = `pow-${i}`;
    if (createHash("sha256").update(nonce).digest("hex").startsWith("0".repeat(difficulty))) return nonce;
  }
}

const POW = validPowNonce();

describe("ChallengeVerifier", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ["log", "warn", "error", "debug"] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it("accepts a valid PoW nonce without calling the captcha provider", async () => {
    const { egress, fetch } = egressMock(async () => reply(200, { success: true }));
    const v = new ChallengeVerifier(config("turnstile"), egress);
    await expect(v.verify({ "x-vortex-pow-response": POW })).resolves.toEqual({ passed: true, method: "pow" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid PoW nonce when no captcha token is sent", async () => {
    const v = new ChallengeVerifier(config(""));
    await expect(v.verify({ "x-vortex-pow-response": "not-a-solution" })).resolves.toEqual({ passed: false });
    await expect(v.verify({})).resolves.toEqual({ passed: false });
  });

  it.each(["hcaptcha", "turnstile"] as const)("accepts a token %s confirms, sending secret/response/remoteip", async (provider) => {
    const { egress, fetch } = egressMock(async () => reply(200, { success: true }));
    const v = new ChallengeVerifier(config(provider), egress);

    await expect(v.verify({ "x-vortex-captcha-response": TOKEN }, "198.51.100.4")).resolves.toEqual({
      passed: true,
      method: "captcha",
      captcha: "valid",
    });

    const [url, opts] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe(CAPTCHA_VERIFY_URLS[provider]);
    expect(opts.method).toBe("POST");
    const form = new URLSearchParams(opts.body);
    expect(form.get("secret")).toBe("server-secret");
    expect(form.get("response")).toBe(TOKEN);
    expect(form.get("remoteip")).toBe("198.51.100.4");
  });

  it("rejects a token the provider says is invalid", async () => {
    const { egress } = egressMock(async () => reply(200, { success: false, "error-codes": ["invalid-input-response"] }));
    const v = new ChallengeVerifier(config("hcaptcha"), egress);
    await expect(v.verify({ "x-vortex-captcha-response": TOKEN })).resolves.toEqual({ passed: false, captcha: "invalid" });
  });

  it.each([
    ["a network error", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["an HTTP 5xx", async () => reply(503, "upstream down")],
    ["a non-JSON body", async () => reply(200, "<html>oops</html>")],
    ["a body without a success flag", async () => reply(200, { ok: 1 })],
  ])("treats %s as unavailable, never as a pass", async (_name, impl) => {
    const { egress } = egressMock(impl as () => Promise<EgressResponse>);
    const v = new ChallengeVerifier(config("turnstile"), egress);
    await expect(v.verify({ "x-vortex-captcha-response": TOKEN })).resolves.toEqual({
      passed: false,
      captcha: "unavailable",
    });
  });

  it("treats a provider that does not answer within the timeout as unavailable", async () => {
    const { egress } = egressMock(() => new Promise<EgressResponse>(() => undefined));
    const v = new ChallengeVerifier(config("turnstile", "server-secret", 50), egress);
    const started = Date.now();
    await expect(v.verifyCaptcha(TOKEN)).resolves.toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still accepts PoW during a captcha outage", async () => {
    const { egress } = egressMock(() => Promise.reject(new Error("timeout")));
    const v = new ChallengeVerifier(config("turnstile"), egress);
    await expect(
      v.verify({ "x-vortex-captcha-response": TOKEN, "x-vortex-pow-response": POW }),
    ).resolves.toEqual({ passed: true, method: "pow" });
  });

  it("ignores the captcha header when no provider or secret is configured", async () => {
    const { egress, fetch } = egressMock(async () => reply(200, { success: true }));
    for (const v of [new ChallengeVerifier(config(""), egress), new ChallengeVerifier(config("turnstile", ""), egress)]) {
      await expect(v.verify({ "x-vortex-captcha-response": TOKEN })).resolves.toEqual({
        passed: false,
        captcha: "disabled",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized token without calling the provider", async () => {
    const { egress, fetch } = egressMock(async () => reply(200, { success: true }));
    const v = new ChallengeVerifier(config("turnstile"), egress);
    await expect(v.verifyCaptcha("x".repeat(5000))).resolves.toBe("invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never logs the raw captcha token", async () => {
    const outcomes = [
      () => Promise.reject(new Error("ECONNRESET")),
      async () => reply(500, "err"),
      async () => reply(200, "not json"),
      async () => reply(200, { success: false }),
    ];
    for (const impl of outcomes) {
      const { egress } = egressMock(impl as () => Promise<EgressResponse>);
      await new ChallengeVerifier(config("hcaptcha"), egress).verifyCaptcha(TOKEN);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(findSensitiveKeyMaterial(logs)).toEqual([]);
  });
});

describe("AbuseDetectorGuard challenge branch", () => {
  function guardWith(verifier: ChallengeVerifier): AbuseDetectorGuard {
    const scorer = {
      score: jest.fn().mockResolvedValue({ total: 30, action: "challenge", signals: [], actors: [], allowlisted: false }),
    } as unknown as AbuseScoreService;
    const allowlist = { isAllowlisted: () => false } as unknown as AllowlistService;
    return new AbuseDetectorGuard(scorer, allowlist, verifier);
  }

  function ctx(headers: Record<string, string>): ExecutionContext {
    const req = { headers, body: { user: "GUSER" }, path: "/api/v1/intents", method: "POST", ip: "198.51.100.4" };
    return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  }

  async function status(guard: AbuseDetectorGuard, headers: Record<string, string>): Promise<number | boolean> {
    try {
      return await guard.canActivate(ctx(headers));
    } catch (err) {
      return (err as HttpException).getStatus();
    }
  }

  beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("lets a request through with only a valid PoW nonce", async () => {
    const guard = guardWith(new ChallengeVerifier(config("")));
    await expect(status(guard, { "x-vortex-pow-response": POW })).resolves.toBe(true);
  });

  it("lets a request through with only a valid captcha token", async () => {
    const { egress } = egressMock(async () => reply(200, { success: true }));
    const guard = guardWith(new ChallengeVerifier(config("turnstile"), egress));
    await expect(status(guard, { "x-vortex-captcha-response": TOKEN })).resolves.toBe(true);
  });

  it("returns 428 for an invalid captcha token", async () => {
    const { egress } = egressMock(async () => reply(200, { success: false }));
    const guard = guardWith(new ChallengeVerifier(config("turnstile"), egress));
    await expect(status(guard, { "x-vortex-captcha-response": TOKEN })).resolves.toBe(428);
  });

  it("returns 428 during a provider outage, and PoW still works", async () => {
    const { egress } = egressMock(() => Promise.reject(new Error("ETIMEDOUT")));
    const guard = guardWith(new ChallengeVerifier(config("turnstile"), egress));
    await expect(status(guard, { "x-vortex-captcha-response": TOKEN })).resolves.toBe(428);
    await expect(status(guard, { "x-vortex-captcha-response": TOKEN, "x-vortex-pow-response": POW })).resolves.toBe(true);
  });

  it("returns 428 with no proof at all", async () => {
    const guard = guardWith(new ChallengeVerifier(config("")));
    await expect(status(guard, {})).resolves.toBe(428);
  });
});
