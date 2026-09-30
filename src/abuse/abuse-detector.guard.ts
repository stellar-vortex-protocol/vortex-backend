/**
 * AbuseDetectorGuard — NestJS execution guard that scores every incoming
 * intent-create (and cancel / solver-accept) request and applies graduated
 * responses.
 *
 * Response ladder
 * ───────────────
 *  pass      → request proceeds normally
 *  challenge → 428 PreconditionRequired: client must present a PoW nonce or
 *              re-authenticate with a higher-tier API key
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
  TooManyRequestsException,
} from "@nestjs/common";
import { Request } from "express";
import { AbuseScoreService } from "./abuse-score.service";
import { AllowlistService } from "./allowlist.service";
import { AbuseContext } from "./abuse.types";
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

@Injectable()
export class AbuseDetectorGuard implements CanActivate {
  private readonly logger = new Logger(AbuseDetectorGuard.name);

  constructor(
    private readonly scorer: AbuseScoreService,
    private readonly allowlist: AllowlistService,
  ) {}

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

    const abuseCtx: AbuseContext = {
      userAddress,
      solverAddress,
      clientIp,
      asn: undefined, // future: integrate MaxMind or ip-api
      srcAmount,
      srcTokenPriceUsd,
      srcTokenDecimals,
      intentFingerprint,
      accountAgeSeconds: undefined, // future: async Horizon fetch
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

      case "challenge":
        // 428 signals the client must present a PoW nonce header
        // (X-Vortex-PoW-Response) or upgrade their API key tier.
        if (!this.validatePoWResponse(req)) {
          throw new PreconditionRequiredException(
            "Proof-of-work challenge required. Include a valid X-Vortex-PoW-Response header or use a higher-tier API key.",
          );
        }
        // Challenge passed — fall through to allow
        break;

      case "pass":
      default:
        break;
    }

    return true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Extract the user Stellar address from the request. */
  private resolveUserAddress(req: Request): string {
    const user: unknown = req.body?.user;
    if (typeof user === "string" && user.length > 0) return user.toLowerCase();
    // For /:id/cancel and /:id/accept routes the field is also "user"
    const actor: unknown = req.body?.actor;
    if (typeof actor === "string" && actor.length > 0) return actor.toLowerCase();
    return `ip:${req.ip ?? "unknown"}`;
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
    const path = req.path ?? "";
    const method = (req.method ?? "").toUpperCase();

    if (method === "POST" && path.endsWith("/cancel")) return "cancel";
    if (method === "POST" && path.endsWith("/accept")) return "accept";
    if (method === "POST" && path.endsWith("/fill")) return "fill";
    return "create";
  }

  private resolveApiKey(req: Request): string | undefined {
    const raw = req.headers["x-api-key"] ?? req.headers["authorization"];
    if (typeof raw === "string" && raw.length > 0) {
      return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    }
    return undefined;
  }

  /**
   * Stable deterministic fingerprint of the intent's economic parameters.
   * Excludes deadline (changes every request) and user (scorer already keys by that).
   */
  private fingerprint(body: Record<string, unknown>): string {
    const relevant = {
      srcChain: body.srcChain,
      srcTokenAddress: body.srcTokenAddress,
      srcAmount: body.srcAmount,
      dstTokenContract: body.dstTokenContract,
      minDstAmount: body.minDstAmount,
    };
    return createHash("sha256")
      .update(JSON.stringify(relevant))
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Basic PoW validation: the client must supply a nonce in
   * `X-Vortex-PoW-Response` whose SHA-256 hash starts with DIFFICULTY leading
   * zeroes (hex).  This is intentionally simple — the goal is to add CPU cost
   * for bots, not cryptographic security.
   */
  private validatePoWResponse(req: Request): boolean {
    const DIFFICULTY = parseInt(process.env.ABUSE_POW_DIFFICULTY ?? "4", 10);
    const nonce = req.headers["x-vortex-pow-response"];
    if (typeof nonce !== "string" || nonce.length === 0) return false;

    const hash = createHash("sha256").update(nonce).digest("hex");
    return hash.startsWith("0".repeat(DIFFICULTY));
  }
}
