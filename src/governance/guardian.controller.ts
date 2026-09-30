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
@Controller("api/v1/governance/guardian")
export class GuardianController {
  constructor(private readonly guardian: GuardianService) {}

  @Get("status")
  @ApiOperation({ summary: "Active guardian actions (with tx references) and effective pause state" })
  status() {
    return this.guardian.status();
  }

  @Post("actions/:id/override")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @RequireAdminRole("superadmin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "Superadmin override of an active guardian action (audited)" })
  async override(
    @Param("id") id: string,
    @Body() dto: GuardianOverrideDto,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return { overridden: await this.guardian.override(id, admin, dto.reason), status: this.guardian.status() };
  }
}
