import { Controller, Get } from "@nestjs/common";
import { StatsService } from "./stats.service";

@Controller("api/v1/stats")
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  getStats() {
    return this.statsService.getProtocolStats();
  }
}
