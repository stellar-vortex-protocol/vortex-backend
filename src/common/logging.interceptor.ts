import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";

interface LoggableRequest {
  method: string;
  originalUrl: string;
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface LoggableResponse {
  statusCode: number;
}

/**
 * Strips newline characters and other ASCII control characters (except tab)
 * from a string to prevent log injection attacks.  A crafted URL containing
 * `%0a` / `%0d` sequences could otherwise forge extra log lines.
 */
function sanitizeForLog(value: string): string {
  // Replace newlines, carriage returns, and all other C0/C1 control characters
  // (except horizontal tab U+0009) with a space so the entry stays on one line.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, " ").trim();
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<LoggableRequest>();
    const response = context.switchToHttp().getResponse<LoggableResponse>();
    const start = Date.now();

    // Validate and bound X-Request-Id before trusting it (#296).
    // Accept only safe alphanumeric/hyphen/underscore IDs up to 64 chars;
    // fall back to a generated UUID for anything that doesn't conform.
    const rawRequestId = Array.isArray(request.headers["x-request-id"])
      ? request.headers["x-request-id"][0]
      : request.headers["x-request-id"];
    const REQUEST_ID_RE = /^[A-Za-z0-9\-_]{1,64}$/;
    request.requestId =
      rawRequestId !== undefined && REQUEST_ID_RE.test(rawRequestId) ? rawRequestId : uuidv4();

    // Sanitize the URL before logging to prevent log-injection via crafted paths.
    // Computed once and used for *both* lines — emitting the raw URL on the
    // correlated line would let an attacker forge an extra entry there.
    const safeUrl = sanitizeForLog(request.originalUrl);

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        // Sanitize both the request ID and URL before logging to prevent
        // log-injection via crafted headers or paths (#293, #296).
        const safeId = sanitizeForLog(request.requestId ?? "");
        logger.info(`[${safeId}] ${request.method} ${safeUrl} ${response.statusCode} ${duration}ms`);
      }),
    );
  }
}
