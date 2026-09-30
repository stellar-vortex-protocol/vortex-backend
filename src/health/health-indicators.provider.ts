import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { DatabaseHealthService } from "./database-health.service";
import { HealthIndicatorRegistry } from "./health-indicator.registry";
import {
  databaseIndicator,
  databaseIsCritical,
  killSwitchIndicator,
  migrationsIndicator,
  rpcQuorumIndicator,
} from "./indicators";

/** Registers the core dependency indicators (issue #492). */
export const coreHealthIndicators = {
  provide: "CORE_HEALTH_INDICATORS",
  inject: [
    HealthIndicatorRegistry,
    DatabaseHealthService,
    PrismaService,
    ConfigService,
    { token: KillSwitchService, optional: true },
  ],
  useFactory: (
    registry: HealthIndicatorRegistry,
    db: DatabaseHealthService,
    prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    killSwitch?: KillSwitchService,
  ) => {
    const dbCritical = databaseIsCritical();
    registry.register(databaseIndicator(db, dbCritical));
    if (dbCritical) registry.register(migrationsIndicator(prisma));
    registry.register(rpcQuorumIndicator(config.get("health", { infer: true }).rpcHealthUrls));
    if (killSwitch) registry.register(killSwitchIndicator(killSwitch));
    return true;
  },
};
