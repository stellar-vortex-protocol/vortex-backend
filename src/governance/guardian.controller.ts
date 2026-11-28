import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { IsString, MaxLength, MinLength } from "class-validator";
import { GuardianService } from "./guardian.service";

export class GuardianOverrideDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

@ApiTags("governance")
@Controller({ path: "governance/guardian", version: "1" })
export class GuardianController {
  constructor(private readonly guardian: GuardianService) {}

  @Get("status")
  @ApiOperation({ summary: "Active guardian actions (with tx references) and effective pause state" })
  status() {
    return this.guardian.status();
  }

  /**
   * Phase 1 — propose a quorum override for an active guardian action.
   *
   * Records a pending override proposal signed by the calling superadmin.
   * A second, distinct superadmin must call the approve endpoint before the
   * action is actually lifted. The proposal expires after 30 minutes.
   */
  @Post("actions/:id/override/propose")
  @HttpCode(202)
  @UseGuards(AdminGuard)
  @RequireAdminRole("superadmin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({
    summary: "Propose a quorum override of an active guardian action (phase 1 of 2, audited)",
  })
  async proposeOverride(
    @Param("id") id: string,
    @Body() dto: GuardianOverrideDto,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    const result = await this.guardian.proposeOverride(id, admin, dto.reason);
    return { ...result, status: this.guardian.status() };
  }

  /**
   * Phase 2 — co-sign a pending override proposal.
   *
   * The approving admin must differ from every admin who has already approved
   * (including the proposer). Once the configured quorum of distinct approvals
   * is reached the override executes immediately and the action is lifted.
   */
  @Post("actions/:id/override/approve")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @RequireAdminRole("superadmin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({
    summary: "Co-sign a pending guardian override proposal (phase 2 of 2, audited)",
  })
  async approveOverride(
    @Param("id") id: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    const result = await this.guardian.approveOverride(id, admin);
    return { ...result, status: this.guardian.status() };
  }
}
