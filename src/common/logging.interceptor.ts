import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { logger } from "./logger";

interface LoggableRequest {
  method: string;
  originalUrl: string;
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

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        logger.info(
          `${request.method} ${request.originalUrl} ${response.statusCode} ${duration}ms`,
        );
      }),
    );
  }
}
