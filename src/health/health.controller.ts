import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags } from "@nestjs/swagger";
import { AppConfig } from "../config/configuration";
import { DatabaseHealthService } from "./database-health.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly dbHealth: DatabaseHealthService,
  ) {}

  @Get()
  async check() {
    const db = await this.dbHealth.check();

    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
      db,
    };
  }
}
