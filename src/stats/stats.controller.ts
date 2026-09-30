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
  getPublicStats() {
    return this.statsService.getPublicStats();
  }

  @Get("public/history")
  getPublicStatsHistory() {
    return this.statsService.getPublicStatsHistory();
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
