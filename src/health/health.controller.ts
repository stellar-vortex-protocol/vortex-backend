import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
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

    let sorobanStatus: string;
    try {
      const health = await this.withTimeout(
        this.sorobanService.getHealth(),
        SOROBAN_TIMEOUT_MS,
      );
      sorobanStatus = health.status;
    } catch {
      sorobanStatus = "unreachable";
    }

    const degraded = sorobanStatus !== "healthy";

    if (degraded) {
      throw new ServiceUnavailableException({
        ...base,
        status: "degraded",
        soroban: { status: sorobanStatus },
      });
    }

    return {
      ...base,
      status: "ok",
      soroban: { status: sorobanStatus },
    };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout")), ms);
      timer.unref();
    });
    return Promise.race([promise, timeout]);
  }
}
