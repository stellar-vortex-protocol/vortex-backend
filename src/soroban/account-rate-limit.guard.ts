import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { Request } from "express";

@Injectable()
export class AccountRateLimitGuard implements CanActivate {
  private readonly requestCounts = new Map<string, { count: number; resetTime: number }>();
  private readonly WINDOW_MS = 60 * 1000; // 1 minute window
  private readonly MAX_REQUESTS = 30; // Maximum 30 requests per minute per IP

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const forwarded = request.headers["x-forwarded-for"];
    const trustedForwardedIp =
      request.ip === "127.0.0.1" && typeof forwarded === "string"
        ? forwarded.split(",")[0]?.trim()
        : undefined;
    const ip = trustedForwardedIp || request.ip || "unknown-ip";
    const now = Date.now();

    const record = this.requestCounts.get(ip);
    if (!record || now > record.resetTime) {
      this.requestCounts.set(ip, { count: 1, resetTime: now + this.WINDOW_MS });
      return true;
    }

    if (record.count >= this.MAX_REQUESTS) {
      throw new HttpException(
        "Too many account lookup requests. Rate limit exceeded to prevent proxy scanning.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count++;
    return true;
  }
}
