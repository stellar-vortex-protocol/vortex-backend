import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { StatsService } from "./stats.service";

@ApiTags("stats")
@Controller("api/v1/stats")
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  getStats() {
    return this.statsService.getProtocolStats();
  }

  @Get("public")
  @ApiOperation({
    summary: "Public protocol transparency snapshot",
    description:
      "Stable, versioned public metadata for external dashboards. Contract is intended to be additive-only across minor changes; any breaking field removal or shape change should require a version bump to a new contract path.",
  })
  getPublicStats() {
    return this.statsService.getPublicStats();
  }

  @Get("ws")
  getWsStats() {
    return this.statsService.getWsStats();
  }
}
