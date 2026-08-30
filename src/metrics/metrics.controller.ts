import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { MetricsService } from "./metrics.service";

@ApiTags("metrics")
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metricsService: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; charset=utf-8")
  async index(): Promise<string> {
    return this.metricsService.metrics();
  }
}
