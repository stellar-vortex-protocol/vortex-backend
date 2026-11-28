import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import {
  ProtocolParamsService,
  ParamsApiResponse,
  ProposedParamsInput,
  ProposalDraftStatus,
} from "./params.service";

export class CreateProposalDto {
  @IsObject()
  proposedParams!: ProposedParamsInput;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;
}

export class UpdateProposalStatusDto {
  @IsString()
  @IsIn(["validated", "submitted", "rejected"])
  status!: ProposalDraftStatus;
}

/**
 * Exposes current governance-controlled protocol parameters and the
 * proposal-draft staging queue (issue #507-params).
 *
 * @see ProtocolParamsService
 */
@ApiTags("governance")
@Controller({ path: "params", version: "1" })
export class ParamsController {
  constructor(private readonly paramsService: ProtocolParamsService) {}

  /**
   * GET /api/v1/params
   *
   * Returns the current, pending, and historical parameter sets.
   */
  @Get()
  @ApiOperation({ summary: "Current and pending governance-controlled protocol parameters" })
  getParams(): ParamsApiResponse {
    return {
      current: this.paramsService.getCurrent(),
      pending: this.paramsService.getPending(),
      history: this.paramsService.getHistory(),
    };
  }

  // ── Proposal draft endpoints ──────────────────────────────────────────────

  /**
   * POST /api/v1/params/proposals
   *
   * Create a governance proposal draft. Validates the proposed params against
   * PARAM_BOUNDS and stores all violations as structured data so the operator
   * can fix them before the on-chain transaction is submitted.
   *
   * - If all params pass validation the draft is created with status "validated".
   * - If any params are out of bounds the draft is created with status "draft"
   *   and the validationErrors array is populated with every violation found.
   */
  @Post("proposals")
  @HttpCode(201)
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "Create a governance parameter-change proposal draft (pre-validated, audited)" })
  async createProposal(
    @Body() dto: CreateProposalDto,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return this.paramsService.createProposal(dto.proposedParams, admin, dto.description);
  }

  /**
   * GET /api/v1/params/proposals
   *
   * List proposal drafts, newest-first. Optionally filter by status.
   */
  @Get("proposals")
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "List governance proposal drafts" })
  @ApiQuery({ name: "status", required: false, enum: ["draft", "validated", "submitted", "rejected"] })
  async listProposals(@Query("status") status?: string) {
    const validStatuses: ProposalDraftStatus[] = ["draft", "validated", "submitted", "rejected"];
    const filter = validStatuses.includes(status as ProposalDraftStatus)
      ? (status as ProposalDraftStatus)
      : undefined;
    return this.paramsService.listProposals(filter);
  }

  /**
   * PATCH /api/v1/params/proposals/:id/status
   *
   * Advance a draft's status:
   * - → "validated"  re-runs validation and updates validationErrors
   * - → "submitted"  marks the draft as submitted (on-chain tx sent out-of-band)
   * - → "rejected"   closes the draft without submission
   */
  @Patch("proposals/:id/status")
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "Advance a proposal draft status (validate / submit / reject)" })
  async updateProposalStatus(
    @Param("id") id: string,
    @Body() dto: UpdateProposalStatusDto,
  ) {
    return this.paramsService.updateProposalStatus(id, dto.status);
  }
}
