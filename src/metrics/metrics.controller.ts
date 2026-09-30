import { Controller, Get, Header, Inject, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { MetricsService } from "./metrics.service";
import { MetricsTokenGuard } from "./metrics-token.guard";

@ApiTags("metrics")
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metricsService: MetricsService) {}

  /**
   * Prometheus scrape endpoint.
   *
   * Access is controlled by MetricsTokenGuard:
   *   - With METRICS_TOKEN set: require `Authorization: Bearer <token>`.
   *   - Without METRICS_TOKEN in non-production: open (local dev / test).
   *   - Without METRICS_TOKEN in production: always 401 (fail closed).
   *
   * Configure your Prometheus scrape job with:
   *   authorization:
   *     type: Bearer
   *     credentials: <METRICS_TOKEN value>
   *
   * Closes #298.
   */
  @Get()
  @UseGuards(MetricsTokenGuard)
  @Header("Content-Type", "text/plain; charset=utf-8")
  async index(): Promise<string> {
    return this.metricsService.metrics();
  }
}
