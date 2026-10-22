import { Global, Module } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminAuditService } from "./admin-audit.service";
import { AdminSecretsController } from "./admin-secrets.controller";
import { SecretsModule } from "../secrets/secrets.module";

/** Admin RBAC guard and audit trail shared by jobs, flags, kill-switch and governance. */
@Global()
@Module({
  imports: [SecretsModule],
  controllers: [AdminSecretsController],
  providers: [AdminGuard, AdminAuditService],
  exports: [AdminGuard, AdminAuditService],
})
export class AdminModule {}