import { Global, Module } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminAuditService } from "./admin-audit.service";

/** Admin RBAC guard and audit trail shared by jobs, flags, kill-switch and governance. */
@Global()
@Module({
  providers: [AdminGuard, AdminAuditService],
  exports: [AdminGuard, AdminAuditService],
})
export class AdminModule {}
