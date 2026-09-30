import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

/**
 * Guards GET /metrics behind a bearer token.
 *
 * When METRICS_TOKEN is set in the environment the client must supply it as:
 *   Authorization: Bearer <token>
 *
 * When METRICS_TOKEN is empty or absent (the default) the guard still blocks
 * all external traffic in production (NODE_ENV=production) so that an operator
 * who forgets to set the token does not accidentally expose the endpoint. In
 * non-production environments an empty token allows unauthenticated scraping
 * from localhost — useful for local Prometheus dev stacks.
 *
 * Why a bearer token rather than an IP allowlist?
 *   An IP allowlist requires infrastructure-level knowledge (Prometheus pod
 *   CIDR, sidecar addresses) that varies between environments and is awkward
 *   to configure via env vars.  A shared secret is portable, easy to rotate,
 *   and understood by every Prometheus scrape config via
 *   `authorization: { type: Bearer, credentials: <token> }`.
 *
 * Closes #298.
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const metricsToken = process.env.METRICS_TOKEN ?? "";
    const nodeEnv = process.env.NODE_ENV ?? "development";

    // In production without a configured token: always deny. Fail closed so
    // a misconfigured deploy never silently exposes internal metrics.
    if (!metricsToken && nodeEnv === "production") {
      throw new UnauthorizedException(
        "GET /metrics is not available: set METRICS_TOKEN to enable authenticated scraping. " +
          "See docs/runbooks/metrics.md.",
      );
    }

    // No token configured outside production: allow (supports local dev
    // Prometheus stacks that scrape without credentials).
    if (!metricsToken) {
      return true;
    }

    // Token configured: require Authorization: Bearer <token>.
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authHeader = request.headers["authorization"] ?? "";
    const [scheme, provided] = authHeader.split(" ");

    if (scheme !== "Bearer" || provided !== metricsToken) {
      throw new UnauthorizedException("Invalid or missing metrics bearer token.");
    }

    return true;
  }
}
