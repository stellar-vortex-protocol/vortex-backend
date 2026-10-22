import { Global, Module } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminAuditService } from "./admin-audit.service";
import { AnnouncementService } from "./announcement.service";
import { AnnouncementController } from "./announcement.controller";
import { IntentsGateway } from "../intents/intents.gateway";

/**
 * Binds the announcement broadcast hook to the shared IntentsGateway transport,
 * mirroring the kill-switch's KILL_SWITCH_WS_BINDING factory. Kept as a
 * post-construction factory so AnnouncementService has no hard dependency on
 * IntentsModule in its critical path.
 */
export const ANNOUNCEMENT_WS_BINDING = Symbol("ANNOUNCEMENT_WS_BINDING");

/** Admin RBAC guard and audit trail shared by jobs, flags, kill-switch and governance. */
@Global()
@Module({
  controllers: [AnnouncementController],
  providers: [
    AdminGuard,
    AdminAuditService,
    AnnouncementService,
    {
      provide: ANNOUNCEMENT_WS_BINDING,
      useFactory: (announcementService: AnnouncementService, gateway: IntentsGateway) => {
        announcementService.broadcastStatus = (event) => gateway.broadcast(event);
        return announcementService;
      },
      inject: [AnnouncementService, IntentsGateway],
    },
  ],
  exports: [AdminGuard, AdminAuditService, AnnouncementService],
})
export class AdminModule {}