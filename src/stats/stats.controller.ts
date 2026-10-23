import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { StatsService } from "./stats.service";

@ApiTags("stats")
@Controller({ path: "stats", version: "1" })
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  getStats() {
    return this.statsService.getProtocolStats();
  }

  @Get("windows")
  @ApiOperation({
    summary: "Get protocol stats broken down by rolling time window",
    description:
      "Returns the same metric shape as GET /api/v1/stats computed independently for the " +
      "1h, 24h and 7d rolling windows plus all-time. Canary intents are excluded from every window.",
  })
  getWindowedStats() {
    return this.statsService.getWindowedStats();
  }

  @Get("treasury")
  getTreasuryStats() {
    return this.statsService.getTreasuryStats();
  }

  @Get("ws")
  getWsStats() {
    return this.statsService.getWsStats();
  }
}