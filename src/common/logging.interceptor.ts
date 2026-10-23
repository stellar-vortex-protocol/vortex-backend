import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { bindLogContext } from "./log-context";
import { LOG_EVENTS } from "./log-schema";
import { createLogger } from "./logger";
import { resolveRequestId } from "./request-context.middleware";

interface LoggableRequest {
  method: string;
  originalUrl: string;
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface LoggableResponse {
  statusCode: number;
}

const log = createLogger("http");

/**
 * Strips newline characters and other ASCII control characters (except tab)
 * from a string to prevent log injection attacks.  A crafted URL containing
 * `%0a` / `%0d` sequences could otherwise forge extra log lines in the
 * `pretty` console format (the JSON format escapes them anyway).
 */
export function sanitizeForLog(value: string): string {
  // Replace newlines, carriage returns, and all other C0/C1 control characters
  // (except horizontal tab U+0009) with a space so the entry stays on one line.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, " ").trim();
}

/**
 * Writes one structured `http.request` record per response (issue #488).
 *
 * The request id is normally assigned by `requestContextMiddleware`, which
 * also opens the log context; the interceptor falls back to resolving it
 * itself so a graph mounted without the middleware (unit harnesses, the
 * e2e `createTestApp`) still correlates.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<LoggableRequest>();
    const response = context.switchToHttp().getResponse<LoggableResponse>();
    const start = Date.now();

    request.requestId ??= resolveRequestId(request);
    bindLogContext({ requestId: request.requestId });

    // Computed once: the raw URL must never reach a log record.
    const safeUrl = sanitizeForLog(request.originalUrl);

    return next.handle().pipe(
      tap(() => {
        log.info("http request completed", {
          event: LOG_EVENTS.HTTP_REQUEST,
          requestId: request.requestId,
          method: request.method,
          path: safeUrl,
          statusCode: response.statusCode,
          durationMs: Date.now() - start,
        });
      }),
    );
  }
}
