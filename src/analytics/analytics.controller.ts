import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { ANALYTICS_METRICS, AnalyticsMetric, AnalyticsQuery } from "./analytics.types";
import { AnalyticsQueryDto } from "./dto/analytics-query.dto";

@ApiTags("analytics")
@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get("solver-benchmark/:address")
  @ApiOperation({
    summary: "Compare one solver's latency and volume with the median solver, per bucket",
    description:
      "For each bucket with any fills, returns the solver's own avgMs/volume/count (null when it had no fills " +
      "in that bucket) and the median of every active solver's avgMs and volume. Honors interval, from, to, " +
      "chain and token; the solver query parameter is ignored here.",
  })
  @ApiParam({ name: "address", description: "Solver address to benchmark" })
  @ApiOkResponse({ description: "Array of SolverBenchmarkPoint, sorted by bucket start" })
  benchmark(@Param("address") address: string, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getSolverBenchmark(this.toQuery(query), address);
  }

  @Get(":metric")
  @ApiOperation({
    summary: "Query an analytics aggregate (volume, fees, latency, solver-share, or token-pair)",
  })
  get(@Param("metric") metric: string, @Query() query: AnalyticsQueryDto) {
    const normalized = metric.toLowerCase() as AnalyticsMetric;
    if (!ANALYTICS_METRICS.includes(normalized)) {
      throw new BadRequestException(
        `Unknown analytics metric "${metric}". Expected one of: ${ANALYTICS_METRICS.join(", ")}`,
      );
    }

    const q = this.toQuery(query);

    switch (normalized) {
      case "volume":
        return this.analyticsService.getVolume(q);
      case "fees":
        return this.analyticsService.getFees(q);
      case "latency":
        return this.analyticsService.getLatency(q);
      case "solver-share":
        return this.analyticsService.getSolverShare(q);
      case "token-pair":
        return this.analyticsService.getTokenPair(q);
    }
  }

  private toQuery(query: AnalyticsQueryDto): AnalyticsQuery {
    return {
      interval: query.interval,
      // DTO accepts Unix epoch seconds; the store works in epoch milliseconds.
      from: query.from * 1000,
      to: query.to * 1000,
      chain: query.chain,
      token: query.token,
      solver: query.solver,
    };
  }
}
