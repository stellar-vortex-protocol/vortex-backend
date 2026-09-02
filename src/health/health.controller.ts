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

  @Get("live")
  live() {
    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
    };
  }

  @Get("ready")
  async ready() {
    const db = await this.dbHealth.check();

    return {
      status: db.status === "ok" ? "ok" : "unreachable",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
      db,
    };
  }

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
