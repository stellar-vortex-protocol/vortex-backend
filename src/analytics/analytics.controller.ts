import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { ANALYTICS_METRICS, AnalyticsMetric, AnalyticsQuery } from "./analytics.types";
import { AnalyticsQueryDto } from "./dto/analytics-query.dto";

@ApiTags("analytics")
@Controller("api/v1/analytics")
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get(":metric")
  @ApiOperation({
    summary: "Query an analytics aggregate (volume, fees, latency, or solver-share)",
  })
  get(@Param("metric") metric: string, @Query() query: AnalyticsQueryDto) {
    const normalized = metric.toLowerCase() as AnalyticsMetric;
    if (!ANALYTICS_METRICS.includes(normalized)) {
      throw new BadRequestException(
        `Unknown analytics metric "${metric}". Expected one of: ${ANALYTICS_METRICS.join(", ")}`,
      );
    }

    const q: AnalyticsQuery = {
      interval: query.interval,
      // DTO accepts Unix epoch seconds; the store works in epoch milliseconds.
      from: query.from * 1000,
      to: query.to * 1000,
      chain: query.chain,
      token: query.token,
    };

    switch (normalized) {
      case "volume":
        return this.analyticsService.getVolume(q);
      case "fees":
        return this.analyticsService.getFees(q);
      case "latency":
        return this.analyticsService.getLatency(q);
      case "solver-share":
        return this.analyticsService.getSolverShare(q);
    }
  }
}
