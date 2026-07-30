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

    request.requestId =
      (Array.isArray(request.headers["x-request-id"])
        ? request.headers["x-request-id"][0]
        : request.headers["x-request-id"]) ?? uuidv4();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        logger.info(
          `[${request.requestId}] ${request.method} ${request.originalUrl} ${response.statusCode} ${duration}ms`,
        );
        // Sanitize the URL before logging to prevent log-injection via crafted paths.
        const safeUrl = sanitizeForLog(request.originalUrl);
        logger.info(`${request.method} ${safeUrl} ${response.statusCode} ${duration}ms`);
      }),
    );
  }
}
