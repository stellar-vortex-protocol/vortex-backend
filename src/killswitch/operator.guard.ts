import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "crypto";
import { AppConfig } from "../config/configuration";

export interface OperatorRequest {
  headers: Record<string, string | string[] | undefined>;
  operator?: string;
}

/**
 * Shared-secret authentication for the operator API (issue #477).
 *
 * Kill-switch controls are the highest-blast-radius endpoints in the service:
 * one request can stop every fill in the protocol. They sit behind a distinct
 * secret rather than any existing client credential so that revoking
 * kill-switch access cannot be confused with revoking normal API access, and so
 * these routes are never accidentally exposed by a broader auth change.
 *
 * The comparison is constant-time: a naive `===` leaks the secret through
 * response timing, which matters more here than on ordinary endpoints.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get("killswitch.operatorToken", { infer: true });

    // No token configured means the control plane is deliberately disabled
    // rather than open — fail closed.
    if (!secret) throw new ForbiddenException("Operator API is not configured");

    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const header = request.headers["x-operator-token"];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || !OperatorGuard.constantTimeEquals(provided, secret)) {
      throw new UnauthorizedException("Invalid operator token");
    }

    // Attributed for the audit trail; two-approval counting is per-identity, so
    // this is what stops one operator satisfying both approvals.
    request.operator = request.headers["x-operator-id"] as string | undefined ?? "operator";
    return true;
  }

  private static constantTimeEquals(a: string, b: string): boolean {
    // Hash both sides so the comparison is always over equal-length input;
    // timingSafeEqual throws on a length mismatch, which would leak the length.
    const hashA = createHash("sha256").update(a).digest();
    const hashB = createHash("sha256").update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
}
