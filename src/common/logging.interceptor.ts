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
      }),
    );
  }
}
