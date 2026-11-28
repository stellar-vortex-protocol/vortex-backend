import { Body, Controller, Delete, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminTokensService } from "./admin-tokens.service";
import { CreateAdminTokenDto, DeleteAdminTokenDto, PatchAdminTokenDto } from "./dto/admin-token.dto";

/**
 * Authenticated token registry (issue #435).
 *
 * Metadata is verified against the chain before it is stored. DELETE soft-delists
 * the row; it does not remove it, so intents that already reference the token
 * keep their copied metadata.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller({ path: "admin/tokens", version: "1" })
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class AdminTokensController {
  constructor(private readonly tokens: AdminTokensService) {}

  @Post()
  @ApiOperation({ summary: "Register a token after on-chain metadata verification" })
  create(@Body() dto: CreateAdminTokenDto, @CurrentAdmin() admin: AdminPrincipal) {
    return this.tokens.create(dto, admin);
  }

  @Post("batch")
  @ApiOperation({
    summary: "Register up to 50 tokens in one call, returning per-item results",
    description:
      "Each entry runs through the same on-chain verification/mismatch/audit path as the single-token create. " +
      "Entries are processed sequentially and a failing entry does not abort the rest of the batch.",
  })
  createBatch(@Body() dtos: CreateAdminTokenDto[], @CurrentAdmin() admin: AdminPrincipal) {
    return this.tokens.createBatch(dtos, admin);
  }

  @Patch()
  @ApiOperation({ summary: "Update token status or re-verified metadata" })
  update(@Body() dto: PatchAdminTokenDto, @CurrentAdmin() admin: AdminPrincipal) {
    return this.tokens.update(dto, admin);
  }

  @Delete()
  @HttpCode(200)
  @ApiOperation({ summary: "Soft-delist a token. Existing intents are left intact." })
  remove(@Body() dto: DeleteAdminTokenDto, @CurrentAdmin() admin: AdminPrincipal) {
    return this.tokens.delist(dto, admin);
  }
}
