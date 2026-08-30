import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerOptions } from "@nestjs/throttler";
import { Request } from "express";

/**
 * Issue #45 — per-user (dto.user) rate limiter for POST /api/v1/intents.
 *
 * A single actor can rotate IPs, so we key on the Stellar address sent in the
 * request body rather than the remote IP.  Falls back to the IP when the body
 * field is absent so the guard is safe to use as a decorator on any route.
 *
 * Limit: 10 intent creations per 60 s per user address.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const user: unknown = req.body?.user;
    if (typeof user === "string" && user.length > 0) {
      return `user:${user.toLowerCase()}`;
    }
    // Fallback to IP for requests without a user field
    return req.ip ?? "unknown";
  }

  protected getThrottlers(_context: ExecutionContext): Promise<ThrottlerOptions[]> {
    return Promise.resolve([
      {
        name: "intent-per-user",
        ttl: 60_000, // 60 s window
        limit: 10,   // max 10 intent creations per user per window
      },
    ]);
  }
}
