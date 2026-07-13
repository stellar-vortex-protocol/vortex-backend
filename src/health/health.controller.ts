import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";

@Controller("health")
export class HealthController {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  @Get()
  check() {
    return {
      status: "ok",
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
    };
  }
}
