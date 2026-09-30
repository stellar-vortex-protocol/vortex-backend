import { Controller, Get, Optional, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AppConfig } from "../config/configuration";
import { DatabaseHealthService } from "./database-health.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { HealthIndicatorRegistry } from "./health-indicator.registry";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly dbHealth: DatabaseHealthService,
    private readonly registry: HealthIndicatorRegistry,
    @Optional() private readonly killSwitch?: KillSwitchService,
  ) {}

  private base() {
    return {
      service: "vortex-backend",
      version: "0.1.0",
      network: `stellar-${this.configService.get("stellar.network", { infer: true })}`,
      uptime: process.uptime(),
    };
  }

  /**
   * Liveness (issue #492): only "is the event loop responsive". Dependency
   * outages never fail it, so Kubernetes does not restart healthy pods.
   */
  @Get("live")
  live(@Res({ passthrough: true }) res: Response) {
    const { alive, eventLoopLagMs } = this.registry.liveness();
    if (!alive) res.status(503);
    return { status: alive ? "ok" : "unresponsive", ...this.base(), eventLoopLagMs };
  }

  /**
   * Readiness (issue #492): every indicator critical to this process's roles
   * is up, with hysteresis. 503 while not ready; `status: "degraded"` when a
   * non-critical dependency is down. Reads cached results only.
   */
  @Get("ready")
  ready(@Res({ passthrough: true }) res: Response) {
    const readiness = this.registry.readiness();
    if (!readiness.ready) res.status(503);
    const db = this.registry.result("database");
    return {
      ...this.base(),
      ...readiness,
      db: db?.status === "up" ? { status: "ok", latencyMs: db.details?.latencyMs } : { status: "unreachable", error: db?.error },
    };
  }

  /** Startup (issue #492): migrations applied and caches warmed. */
  @Get("startup")
  startup(@Res({ passthrough: true }) res: Response) {
    const startup = this.registry.startup();
    if (!startup.started) res.status(503);
    return { status: startup.started ? "ok" : "starting", ...this.base(), ...startup };
  }

  /** Legacy aggregate endpoint, kept for backward compatibility. */
  @Get()
  async check() {
    const db = await this.dbHealth.check();
    const killswitch = this.killSwitch?.status();
    const backplane = this.registry.result("ws_backplane");

    return {
      status: "ok",
      ...this.base(),
      db,
      // Issue #454 — WS backplane state for this replica.
      ...(backplane ? { backplane: { status: backplane.status, ...backplane.details } } : {}),
      // Issue #477 — an active pause is an operational state, not an outage:
      // liveness stays "ok" so a pause never triggers a restart loop. Callers
      // that need to distinguish "healthy but paused" read `killswitch`.
      ...(killswitch
        ? {
            killswitch: {
              ready: killswitch.ready,
              propagation: killswitch.propagation,
              activePauses: killswitch.switches
                .filter((entry) => entry.active)
                .map((entry) => ({
                  scope: entry.scope,
                  chain: entry.chain,
                  token: entry.token,
                  operation: entry.operation,
                  reasonCode: entry.reasonCode,
                  since: entry.updatedAt,
                })),
            },
          }
        : {}),
    };
  }
}
