import { Global, Module } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminAuditService } from "./admin-audit.service";
import { AdminSecretsController } from "./admin-secrets.controller";
import { CanaryRegistryController } from "./canary-registry.controller";
import { CanaryRegistryService } from "./canary-registry.service";
import { EgressHealthController } from "./egress-health.controller";
import { AdminConfigController } from "./admin-config.controller";
import { SecretsModule } from "../secrets/secrets.module";
import { PrismaModule } from "../prisma/prisma.module";

/** Admin RBAC guard and audit trail shared by jobs, flags, kill-switch and governance. */
@Global()
@Module({
  imports: [SecretsModule, PrismaModule],
  controllers: [
    AdminSecretsController,
    CanaryRegistryController,
    EgressHealthController,
    AdminConfigController,
  ],
  providers: [AdminGuard, AdminAuditService, CanaryRegistryService],
  exports: [AdminGuard, AdminAuditService, CanaryRegistryService],
})
export class AdminModule {}
