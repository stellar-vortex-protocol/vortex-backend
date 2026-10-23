import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { analyticsToCsv } from "./analytics-csv";
import { AnalyticsService } from "./analytics.service";
import {
  ANALYTICS_METRICS,
  AnalyticsMetric,
  AnalyticsQuery,
  GroupedPoint,
  normalizeGroupBy,
} from "./analytics.types";
import { AnalyticsGroupedQueryDto } from "./dto/analytics-grouped-query.dto";
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

  @Post("query")
  @HttpCode(200)
  @ApiOperation({
    summary: "Ad-hoc volume/fees aggregate grouped by any subset of chain, token, and solver",
    description:
      "Returns one row per time bucket × group-by combination. `groupBy` only accepts the " +
      "enumerated dimensions; an empty `groupBy` returns the same rows as GET /analytics/{metric}. " +
      "`token` groups by the fill's source token.",
  })
  query(@Body() body: AnalyticsGroupedQueryDto): Promise<GroupedPoint[]> {
    return this.analyticsService.getGrouped({
      metric: body.metric,
      interval: body.interval,
      // DTO accepts Unix epoch seconds; the store works in epoch milliseconds.
      from: body.from * 1000,
      to: body.to * 1000,
      chain: body.chain,
      token: body.token,
      groupBy: normalizeGroupBy(body.groupBy ?? []),
    });
  }

  @Get(":metric")
  @ApiOperation({
    summary: "Query an analytics aggregate (volume, fees, latency, solver-share, or token-pair)",
    description:
      "JSON by default. Pass `?format=csv` (or send `Accept: text/csv`) to download the same rows " +
      "as CSV, with a header row matching the JSON field names.",
  })
  @ApiParam({ name: "metric", enum: ANALYTICS_METRICS })
  @ApiProduces("application/json", "text/csv")
  async get(
    @Param("metric") metric: string,
    @Query() query: AnalyticsQueryDto,
    @Headers("accept") accept: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const normalized = metric.toLowerCase() as AnalyticsMetric;
    if (!ANALYTICS_METRICS.includes(normalized)) {
      throw new BadRequestException(
        `Unknown analytics metric "${metric}". Expected one of: ${ANALYTICS_METRICS.join(", ")}`,
      );
    }

    const q = this.toQuery(query);

    const points = await this.fetch(normalized, q);

    // An explicit ?format wins; otherwise honour an Accept header asking for CSV.
    const wantsCsv = query.format ? query.format === "csv" : /\btext\/csv\b/i.test(accept ?? "");
    if (!wantsCsv) return points;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${normalized}.csv"`);
    return analyticsToCsv(normalized, points);
  }

  private fetch(metric: AnalyticsMetric, q: AnalyticsQuery): Promise<object[]> {
    switch (metric) {
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
