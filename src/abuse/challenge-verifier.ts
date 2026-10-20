/**
 * ChallengeVerifier — decides whether a request carries an accepted proof for
 * the abuse detector's `challenge` action (issue #606).
 *
 * Two proofs are accepted; either one is enough:
 *
 *  - Proof of work: `X-Vortex-PoW-Response` holds a nonce whose SHA-256 hex
 *    digest starts with ABUSE_POW_DIFFICULTY zeroes (unchanged from before).
 *  - Captcha: `X-Vortex-Captcha-Response` holds an hCaptcha or Cloudflare
 *    Turnstile token, checked server-side against the provider's siteverify
 *    API. This gives human users on a browser a way through that does not
 *    burn CPU.
 *
 * Fail closed: a captcha token only counts when the provider answers
 * `success: true`. Invalid tokens, a provider outage, a timeout or a missing
 * configuration all leave the request needing a valid PoW nonce; they never
 * downgrade the challenge to a pass.
 *
 * The captcha token is treated like a credential: it is sent only to the
 * provider and never logged.
 */

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { AppConfig } from "../config/configuration";
import { EgressPurpose, HttpEgressService } from "../common/http-egress";

export const POW_RESPONSE_HEADER = "x-vortex-pow-response";
export const CAPTCHA_RESPONSE_HEADER = "x-vortex-captcha-response";

/** Optional injection token to supply the egress client used for captcha calls (tests). */
export const CAPTCHA_EGRESS = Symbol("CAPTCHA_EGRESS");

/** siteverify endpoints per provider. */
export const CAPTCHA_VERIFY_URLS = {
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
} as const;

/** Tokens longer than this are rejected without calling the provider. */
const MAX_CAPTCHA_TOKEN_LENGTH = 4096;

/**
 * Result of a captcha check.
 *  - valid:       provider confirmed the token
 *  - invalid:     provider rejected the token (or it was malformed)
 *  - unavailable: provider could not be reached or gave an unusable answer
 *  - disabled:    no captcha provider is configured
 */
export type CaptchaOutcome = "valid" | "invalid" | "unavailable" | "disabled";

export interface ChallengeResult {
  passed: boolean;
  /** Which proof cleared the challenge, when one did. */
  method?: "pow" | "captcha";
  /** Captcha outcome, when a captcha token was presented. */
  captcha?: CaptchaOutcome;
}

type HeaderBag = Record<string, string | string[] | undefined>;

@Injectable()
export class ChallengeVerifier {
  private readonly logger = new Logger(ChallengeVerifier.name);
  private readonly captcha: AppConfig["abuse"]["captcha"];
  private readonly egress?: HttpEgressService;

  constructor(
    @Optional() config?: ConfigService<AppConfig, true>,
    @Optional() @Inject(CAPTCHA_EGRESS) egress?: HttpEgressService,
  ) {
    this.captcha = config?.get("abuse", { infer: true })?.captcha ?? { provider: "", secret: "", timeoutMs: 3000 };
    if (this.captchaEnabled()) {
      const url = new URL(CAPTCHA_VERIFY_URLS[this.captcha.provider as keyof typeof CAPTCHA_VERIFY_URLS]);
      this.egress =
        egress ??
        new HttpEgressService({
          timeoutMs: this.captcha.timeoutMs,
          maxRedirects: 0,
          maxBodySizeBytes: 16_384,
          allowlist: [url.hostname],
          blockPrivateRanges: true,
        });
    }
  }

  /** True when any accepted proof in `headers` is valid. PoW is checked first (no I/O). */
  async verify(headers: HeaderBag, remoteIp?: string): Promise<ChallengeResult> {
    if (this.verifyPow(headers[POW_RESPONSE_HEADER])) return { passed: true, method: "pow" };

    const token = headers[CAPTCHA_RESPONSE_HEADER];
    if (typeof token !== "string" || token.length === 0) return { passed: false };

    const captcha = await this.verifyCaptcha(token, remoteIp);
    return captcha === "valid" ? { passed: true, method: "captcha", captcha } : { passed: false, captcha };
  }

  /**
   * Basic PoW validation: the nonce's SHA-256 hash must start with DIFFICULTY
   * leading zeroes (hex). This is intentionally simple — the goal is to add
   * CPU cost for bots, not cryptographic security.
   */
  verifyPow(nonce: unknown): boolean {
    const difficulty = parseInt(process.env.ABUSE_POW_DIFFICULTY ?? "4", 10);
    if (typeof nonce !== "string" || nonce.length === 0) return false;
    const hash = createHash("sha256").update(nonce).digest("hex");
    return hash.startsWith("0".repeat(difficulty));
  }

  /** Check a captcha token with the configured provider. Never throws. */
  async verifyCaptcha(token: string, remoteIp?: string): Promise<CaptchaOutcome> {
    if (!this.captchaEnabled() || !this.egress) return "disabled";
    if (token.length === 0 || token.length > MAX_CAPTCHA_TOKEN_LENGTH) return "invalid";

    const provider = this.captcha.provider as keyof typeof CAPTCHA_VERIFY_URLS;
    const form = new URLSearchParams({ secret: this.captcha.secret, response: token });
    if (remoteIp) form.set("remoteip", remoteIp);

    try {
      const res = await this.withTimeout(
        this.egress.fetch(CAPTCHA_VERIFY_URLS[provider], {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          purpose: EgressPurpose.GENERIC,
        }),
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        this.logger.warn(`[challenge] ${provider} siteverify returned HTTP ${res.statusCode}; requiring PoW`);
        return "unavailable";
      }
      const body = JSON.parse(res.body) as { success?: unknown };
      if (typeof body.success !== "boolean") {
        this.logger.warn(`[challenge] ${provider} siteverify response had no success flag; requiring PoW`);
        return "unavailable";
      }
      return body.success ? "valid" : "invalid";
    } catch (err) {
      // The error comes from the egress client or JSON parsing, never from the
      // token itself, so it is safe to log the message.
      this.logger.warn(`[challenge] ${provider} siteverify failed (${(err as Error).message}); requiring PoW`);
      return "unavailable";
    }
  }

  private captchaEnabled(): boolean {
    return this.captcha.provider in CAPTCHA_VERIFY_URLS && this.captcha.secret.length > 0;
  }

  /** Hard deadline on top of the egress client's own socket timeouts (covers DNS too). */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${this.captcha.timeoutMs}ms`)), this.captcha.timeoutMs);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }
}
