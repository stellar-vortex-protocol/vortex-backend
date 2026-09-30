import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AppConfig } from "../../config/configuration";
import { resolveClientIp } from "../../intents/ws/connection-state";
import { ApiKeyService } from "../api-keys/api-key.service";
import { DEFAULT_TIER, TIER_LIMITS } from "../api-keys/api-key-tiers";
import { DistributedRateLimiter } from "./distributed-rate-limiter";

/** Window size for the tiered rate limiter (60 s sliding window). */
const WINDOW_MS = 60_000;

/**
 * Tiered, distributed rate-limit guard (issue #441).
 *
 * Replaces the legacy per-process global IP throttle. The quota is selected by
 * the caller's API key tier:
 *
 *   - No API key  → `public` tier, tracked per client IP.
 *   - Valid key   → the key's tier, tracked per credential prefix.
 *
 * The limit is enforced by the Redis-backed {@link DistributedRateLimiter}, so
 * every replica shares one global quota. On Redis failure a bounded local
 * fallback keeps the limit enforced per process (never unlimited).
 *
 * Every guarded response carries the standard `RateLimit-Limit`,
 * `RateLimit-Remaining` and `RateLimit-Reset` headers; denied requests get
 * `429` plus `Retry-After`.
 */
@Injectable()
export class TieredThrottleGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: DistributedRateLimiter,
    private readonly apiKeys: ApiKeyService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.trustProxyHops = config.get("ws", { infer: true }).trustProxyHops;
  }

  private readonly trustProxyHops: number;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const presented = TieredThrottleGuard.extractApiKey(req);
    const keyRecord = presented ? await this.apiKeys.resolveKey(presented) : null;

    const tier = keyRecord?.tier ?? DEFAULT_TIER;
    const limit = TIER_LIMITS[tier].requestsPerMinute;
    const tracker = keyRecord ? `apiKey:${keyRecord.keyPrefix}` : `ip:${this.clientIp(req)}`;

    const result = await this.rateLimiter.consume(tracker, limit, WINDOW_MS);

    res.setHeader("RateLimit-Limit", String(limit));
    if (!result) {
      // The limiter itself failed in an untrusted way — fail closed.
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader("RateLimit-Reset", String(Math.ceil((Date.now() + WINDOW_MS) / 1000)));
      throw new HttpException("Rate limiter unavailable", HttpStatus.SERVICE_UNAVAILABLE);
    }

    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      throw new HttpException("Too Many Requests", HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  /** Extract the API key from `Authorization: Bearer` or `x-api-key`. */
  private static extractApiKey(req: Request): string | null {
    const auth = req.headers?.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const token = auth.slice(7).trim();
      if (token) return token;
    }
    const header = req.headers?.["x-api-key"];
    if (typeof header === "string" && header) return header;
    return null;
  }

  private clientIp(req: Request): string {
    return resolveClientIp(req.socket?.remoteAddress, req.headers?.["x-forwarded-for"], this.trustProxyHops);
  }
}
