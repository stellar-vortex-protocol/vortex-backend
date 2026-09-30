import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { FeatureFlagService } from "./feature-flag.service";
import { UpdateFlagDto } from "./update-flag.dto";

/** Admin API for runtime feature flags (issue #495). Every change is audited. */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller("admin/flags")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class FlagsController {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Managed flags with env default, override pin and stored rules" })
  list() {
    return { flags: this.flags.list() };
  }

  @Put(":key")
  @ApiOperation({
    summary: "Set a flag's default and targeting rules",
    description: "Returns 202-style { status: 'pending' } when a second approval is required.",
  })
  update(@Param("key") key: string, @Body() dto: UpdateFlagDto, @CurrentAdmin() admin: AdminPrincipal) {
    return this.flags.update(key, { defaultValue: dto.defaultValue, rules: dto.rules }, admin, dto.reason);
  }

  @Post("change-requests/:id/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve a pending change (must be a different admin than the proposer)" })
  approve(@Param("id") id: string, @CurrentAdmin() admin: AdminPrincipal) {
    return this.flags.approve(id, admin);
  }

  @Get(":key/audit")
  @ApiOperation({ summary: "Audit trail for a flag, newest first" })
  async auditLog(@Param("key") key: string) {
    const entries = await this.audit.forTarget(`flag:${key}`);
    return { entries: entries.map((e) => ({ ...e, id: e.id.toString() })) };
  }
}
