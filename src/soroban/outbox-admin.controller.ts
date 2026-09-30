import { Controller, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiNotFoundResponse, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { IOutboxRepository, OUTBOX_REPOSITORY } from "./outbox.repository";

/**
 * Operator actions on the transactional outbox (issue #396). Registered in
 * IntentsModule, which owns the OUTBOX_REPOSITORY binding.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller("api/v1/admin/outbox")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class OutboxAdminController {
  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: IOutboxRepository,
    private readonly audit: AdminAuditService,
  ) {}

  /** Moves a `dead` row back to `pending` with attempts reset, unblocking its intent. */
  @Post(":id/requeue")
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  @ApiNotFoundResponse({ description: "No dead outbox row with this id" })
  async requeue(@Param("id") id: string, @CurrentAdmin() admin: AdminPrincipal) {
    if (!/^\d+$/.test(id)) throw new NotFoundException(`No dead outbox row with id ${id}`);
    await this.audit.record({ actor: admin.id, action: "outbox.requeue", target: `outbox:${id}` });
    if (!(await this.outbox.requeueDead(id))) {
      throw new NotFoundException(`No dead outbox row with id ${id}`);
    }
    return { id, status: "pending" };
  }
}
