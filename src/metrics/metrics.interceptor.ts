import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { MetricsService } from "./metrics.service";

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const start = Date.now();
    const method = request.method;
    const route = request.route?.path || request.originalUrl || request.url || "unknown";

    return next.handle().pipe(
      tap(() => {
        const statusCode = response.statusCode;
        const duration = (Date.now() - start) / 1000;

        this.metricsService.httpRequestTotal.inc({ method, route, status_code: statusCode });
        this.metricsService.httpRequestDuration.observe({ method, route, status_code: statusCode }, duration);
        if (statusCode >= 500) {
          this.metricsService.httpRequestErrors.inc({ method, route, status_code: statusCode });
        }
      }),
    );
  }
}
