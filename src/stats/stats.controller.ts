import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { StatsService } from "./stats.service";

@ApiTags("stats")
@Controller("api/v1/stats")
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  getStats() {
    return this.statsService.getProtocolStats();
  }
}
