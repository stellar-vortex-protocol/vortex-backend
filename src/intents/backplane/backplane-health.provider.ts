import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { HealthIndicatorRegistry } from "../../health/health-indicator.registry";
import { IntentsGateway } from "../intents.gateway";

/**
 * Registers the WS backplane as a health indicator (issues #454, #492):
 * critical for the `ws` role when WS_BACKPLANE=redis.
 */
export const backplaneHealthIndicator = {
  provide: "WS_BACKPLANE_HEALTH_INDICATOR",
  inject: [{ token: HealthIndicatorRegistry, optional: true }, IntentsGateway, ConfigService],
  useFactory: (
    registry: HealthIndicatorRegistry | undefined,
    gateway: IntentsGateway,
    config: ConfigService<AppConfig, true>,
  ) => {
    registry?.register({
      name: "ws_backplane",
      criticalFor: config.get("wsBackplane", { infer: true }) === "redis" ? ["ws"] : [],
      async check() {
        const health = gateway.backplaneHealth();
        return { status: health.status === "down" ? "down" : "up", details: { ...health } };
      },
    });
    return true;
  },
};
