import { Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOkResponse, ApiQuery, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { TtlKeeperReport, TtlKeeperService } from "./ttl-keeper.service";

/**
 * Admin view of the contract-state TTL keeper (issue #395).
 *
 * `GET` is read-only: it scans every tracked ledger key over RPC and reports
 * its remaining TTL without submitting anything. `POST /run` performs a keeper
 * run now (extensions included, within the daily budget) on whichever replica
 * receives the request, and is audited.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller({ path: "admin/soroban/ttl", version: "1" })
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class TtlKeeperController {
  constructor(
    private readonly keeper: TtlKeeperService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Tracked keys with their remaining TTL, plus threshold and budget state. */
  @Get()
  @ApiQuery({
    name: "cached",
    required: false,
    description: "true = return the last keeper run's report instead of scanning now",
  })
  @ApiOkResponse({ description: "TTL report for every protocol-owned persistent entry" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async report(@Query("cached") cached?: string): Promise<TtlKeeperReport | { report: null }> {
    if (cached === "true") return this.keeper.getLastReport() ?? { report: null };
    return this.keeper.report();
  }

  /** Run the keeper immediately (scan + extend below-threshold keys). */
  @Post("run")
  @HttpCode(200)
  @ApiOkResponse({ description: "Report of the run, including submitted extensions" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async run(@CurrentAdmin() admin: AdminPrincipal): Promise<TtlKeeperReport> {
    await this.audit.record({ actor: admin.id, action: "soroban.ttl.run", target: "ttl-keeper" });
    return this.keeper.run();
  }
}
