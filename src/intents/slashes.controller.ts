import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { buildFillProofMessage, verifyStellarSignature } from "../common/stellar-signature";
import { AdminCancelSlashDto, FillProofDto, ListSlashesDto } from "./dto/slash.dto";
import { SlashingPipelineService } from "./slashing-pipeline.service";

/**
 * Public surface of the slashing saga (issue #397): status lookup and the
 * solver's fill-proof challenge.
 */
@ApiTags("slashes")
@Controller("api/v1/slashes")
export class SlashesController {
  constructor(private readonly pipeline: SlashingPipelineService) {}

  @Get(":intentId")
  @ApiNotFoundResponse({ description: "No slash recorded for this intent" })
  async get(@Param("intentId") intentId: string) {
    const slash = await this.pipeline.getByIntent(intentId);
    if (!slash) throw new NotFoundException(`No slash recorded for intent ${intentId}`);
    return slash;
  }

  @Post(":intentId/fill-proof")
  @ApiUnauthorizedResponse({ description: "Signature invalid" })
  @ApiForbiddenResponse({ description: "Caller is not the slashed solver" })
  @ApiConflictResponse({ description: "Challenge window is over" })
  @ApiUnprocessableEntityResponse({ description: "Fill proof did not verify on-chain" })
  async fillProof(@Param("intentId") intentId: string, @Body() dto: FillProofDto) {
    const txHash = dto.txHash.toLowerCase();
    verifyStellarSignature(dto.solver, buildFillProofMessage(intentId, dto.solver, txHash), dto.signature);
    return this.pipeline.cancelByFillProof(intentId, dto.solver, txHash);
  }
}

/**
 * Operator surface of the slashing saga (issue #397). Runbook:
 * docs/runbooks/slash-cancellation.md.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller("api/v1/admin/slashes")
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class AdminSlashesController {
  constructor(
    private readonly pipeline: SlashingPipelineService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async list(@Query() dto: ListSlashesDto) {
    const slashes = await this.pipeline.list(dto.state, dto.limit ?? 50);
    return { slashes, count: slashes.length };
  }

  /** Cancels a slash that has not been broadcast yet. Audited before it is applied. */
  @Post(":intentId/cancel")
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  @ApiConflictResponse({ description: "Slash already submitted, or submission in progress" })
  async cancel(
    @Param("intentId") intentId: string,
    @Body() dto: AdminCancelSlashDto,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.audit.record({
      actor: admin.id,
      action: "slash.cancel",
      target: `slash:${intentId}`,
      reason: dto.note,
    });
    return this.pipeline.cancelByAdmin(intentId, admin.id, dto.note);
  }
}
