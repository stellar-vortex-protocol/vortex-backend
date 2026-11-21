/**
 * AbuseDetectorGuard — NestJS execution guard that scores every incoming
 * intent-create (and cancel / solver-accept) request and applies graduated
 * responses.
 *
 * Response ladder
 * ───────────────
 *  pass      → request proceeds normally
 *  challenge → 428 PreconditionRequired: client must present a PoW nonce
 *              (X-Vortex-PoW-Response) or a captcha token
 *              (X-Vortex-Captcha-Response, for browser users — issue #606),
 *              or re-authenticate with a higher-tier API key
 *  throttle  → 429 TooManyRequests: caller is rate-limited to 5 req/min
 *  block     → 403 Forbidden: request rejected; logged and audited
 *
 * All actions are reversible: the Redis score decays as the sliding window
 * advances, and an operator can manually clear keys via the admin API or
 * Redis CLI.
 *
 * Guard placement: `@UseGuards(AbuseDetectorGuard)` on routes that mutate
 * intent state.  The guard reads but does not modify the request body so it
 * can sit ahead of class-validator DTOs.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { Request } from "express";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import { AccountAgeService } from "./account-age.service";
import { ChallengeVerifier } from "./challenge-verifier";
import { AbuseContext } from "./abuse.types";
import { AsnLookupProvider } from "./asn-lookup.provider";
import { logger as winstonLogger } from "../common/logger";
import { createHash } from "crypto";
import { ATTR } from "../tracing";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";

/** Custom 428 Precondition Required for the challenge action. */
class PreconditionRequiredException extends HttpException {
  constructor(message: string) {
    super({ statusCode: 428, error: "Precondition Required", message }, 428);
  }
}

/**
 * 429 Too Many Requests for the throttle action.
 *
 * Declared locally because the installed `@nestjs/common` build does not
 * export a `TooManyRequestsException`; mirroring {@link PreconditionRequiredException}
 * keeps the guard independent of that export.
 */
class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super({ statusCode: 429, error: "Too Many Requests", message }, 429);
  }
}

@Injectable()
export class AbuseDetectorGuard implements CanActivate {
  private readonly logger = new Logger(AbuseDetectorGuard.name);

  private readonly challengeVerifier: ChallengeVerifier;
  private readonly accountAge?: AccountAgeService;
  private readonly asnLookup?: AsnLookupProvider;

  constructor(
    private readonly scorer: AbuseScoreService,
    private readonly allowlist: AllowlistService,
    @Optional() challengeVerifier?: ChallengeVerifier,
    @Optional() accountAge?: AccountAgeService,
    @Optional() asnLookup?: AsnLookupProvider,
  ) {
    if (challengeVerifier && "getAccountAgeSeconds" in (challengeVerifier as unknown as Record<string, unknown>)) {
      this.accountAge = challengeVerifier as unknown as AccountAgeService;
      this.challengeVerifier = new ChallengeVerifier();
    } else {
      this.challengeVerifier = challengeVerifier ?? new ChallengeVerifier();
      this.accountAge = accountAge;
    }
    this.asnLookup = asnLookup;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req: Request = ctx.switchToHttp().getRequest();

    const userAddress = this.resolveUserAddress(req);
    const solverAddress = this.resolveSolverAddress(req);
    const clientIp = this.resolveClientIp(req);
    const operation = this.resolveOperation(req);
    const apiKey = this.resolveApiKey(req);
    const srcAmount: string = req.body?.srcAmount ?? "0";
    const srcTokenPriceUsd: number | undefined = req.body?.srcToken?.priceUSD;
    const srcTokenDecimals: number | undefined = req.body?.srcTokenDecimals;
    const intentFingerprint = this.fingerprint(req.body ?? {});

    const allowlisted = this.allowlist.isAllowlisted({ userAddress, clientIp, apiKey });
    const accountAgeSeconds = await this.resolveAccountAge(req, operation);
    const asn = await this.resolveAsn(clientIp);

    const abuseCtx: AbuseContext = {
      userAddress,
      solverAddress,
      clientIp,
      asn,
      srcAmount,
      srcTokenPriceUsd,
      srcTokenDecimals,
      intentFingerprint,
      accountAgeSeconds,
      operation,
    };

    const result = await this.scorer.score(abuseCtx, allowlisted);

    if (result.action !== "pass") {
      winstonLogger.warn("[abuse-detector] non-pass action", {
        userAddress,
        clientIp,
        operation,
        score: result.total,
        action: result.action,
        signals: result.signals.map((s) => s.signal),
        allowlisted,
      });
    }

    switch (result.action) {
      case "block":
        throw new ForbiddenException(
          "Request blocked due to abuse detection. If this is a mistake, contact support.",
        );

      case "throttle":
        // 429 with a Retry-After header; the sliding window decays naturally
        throw new TooManyRequestsException(
          "Request rate limited due to suspicious activity. Please slow down.",
        );

      case "challenge": {
        // 428 signals the client must present an accepted proof: a PoW nonce
        // (X-Vortex-PoW-Response) or a captcha token (X-Vortex-Captcha-Response).
        // Either one is enough. A captcha outage leaves PoW as the only way through.
        const proof = await this.challengeVerifier.verify(req.headers, clientIp);
        if (!proof.passed) {
          throw new PreconditionRequiredException(
            proof.captcha === "unavailable"
              ? "Captcha verification is unavailable. Include a valid X-Vortex-PoW-Response header or use a higher-tier API key."
              : "Challenge required. Include a valid X-Vortex-PoW-Response or X-Vortex-Captcha-Response header, or use a higher-tier API key.",
          );
        }
        // Challenge passed — fall through to allow
        break;
      }

      case "pass":
      default:
        break;
    }

    return true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the client's ASN via the configured provider. Fails open: any
   * error/timeout (bounded by the provider) yields `undefined` so scoring
   * proceeds exactly as before enrichment.
   */
  private async resolveAsn(clientIp: string): Promise<string | undefined> {
    if (!this.asnLookup) return undefined;
    try {
      return await this.asnLookup.lookup(clientIp);
    } catch {
      return undefined;
    }
  }

  /** Extract the user Stellar address from the request. */
  private resolveUserAddress(req: Request): string {
    const user: unknown = req.body?.user;
    if (typeof user === "string" && user.length > 0) return user.toLowerCase();
    // For /:id/cancel and /:id/accept routes the field is also "user"
    const actor: unknown = req.body?.actor;
    if (typeof actor === "string" && actor.length > 0) return actor.toLowerCase();
    return `ip:${req.ip ?? "unknown"}`;
  }

  /**
   * Account age for the `new_address` rule, from a cached Horizon lookup.
   * Only fetched for intent creation while the rule is enabled. Uses the raw
   * `user` field because Stellar strkeys are case-sensitive and
   * `resolveUserAddress` lower-cases. `undefined` (rule stays silent) when the
   * lookup is unavailable or the user is not a Stellar address.
   */
  private async resolveAccountAge(
    req: Request,
    operation: AbuseContext["operation"],
  ): Promise<number | undefined> {
    if (!this.accountAge || operation !== "create") return undefined;
    if (!this.scorer.isRuleEnabled("new_address")) return undefined;
    const user: unknown = req.body?.user;
    if (typeof user !== "string" || user.length === 0) return undefined;
    return this.accountAge.getAccountAgeSeconds(user);
  }

  private resolveSolverAddress(req: Request): string | undefined {
    const solver: unknown = req.body?.solver;
    if (typeof solver === "string" && solver.length > 0) return solver.toLowerCase();
    return undefined;
  }

  private resolveClientIp(req: Request): string {
    // Trust X-Forwarded-For when behind a reverse proxy;
    // use the socket address as the most-trusted fallback.
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.ip ?? req.socket?.remoteAddress ?? "unknown";
  }

  private resolveOperation(req: Request): AbuseContext["operation"] {
    const path = req.path ?? req.url ?? "";
    if (path.includes("/cancel")) return "cancel";
    if (path.includes("/accept")) return "solver_accept";
    return "create";
  }

  private resolveApiKey(req: Request): string | undefined {
    const key = req.headers["x-api-key"];
    if (typeof key === "string" && key.length > 0) return key;
    return undefined;
  }

  private fingerprint(body: unknown): string {
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
}
