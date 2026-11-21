import { Controller, Get, Inject, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiNotFoundResponse, ApiQuery, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";
import { AdminAuditService } from "../admin/admin-audit.service";
import { IOutboxRepository, OUTBOX_REPOSITORY, OutboxStatus } from "./outbox.repository";
import { FeeBumpDecisionRepository } from "./fee-bump-decision.repository";

const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  "pending",
  "processing",
  "submitted",
  "confirmed",
  "dead",
  "simulated",
];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Operator actions on the transactional outbox (issue #396). Registered in
 * IntentsModule, which owns the OUTBOX_REPOSITORY binding.
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller({ path: "admin/outbox", version: "1" })
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class OutboxAdminController {
  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: IOutboxRepository,
    private readonly audit: AdminAuditService,
    private readonly feeBumpDecisions: FeeBumpDecisionRepository,
  ) {}

  /** Lists outbox rows with optional status/operation/intentId filters and cursor pagination. */
  @Get()
  @ApiQuery({ name: "status", required: false, enum: OUTBOX_STATUSES })
  @ApiQuery({ name: "operation", required: false, type: String })
  @ApiQuery({ name: "intentId", required: false, type: String })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  async list(
    @Query("status") status?: string,
    @Query("operation") operation?: string,
    @Query("intentId") intentId?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit === undefined ? DEFAULT_PAGE_SIZE : Number(limit);
    const pageSize =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    const filter: { status?: OutboxStatus; operation?: string; intentId?: string } = {};
    if (status !== undefined && status !== "") {
      if (!OUTBOX_STATUSES.includes(status as OutboxStatus)) {
        throw new NotFoundException(`Unknown outbox status ${status}`);
      }
      filter.status = status as OutboxStatus;
    }
    if (operation !== undefined && operation !== "") filter.operation = operation;
    if (intentId !== undefined && intentId !== "") filter.intentId = intentId;

    const page = await this.outbox.list(filter, {
      cursor: cursor !== undefined && cursor !== "" ? cursor : undefined,
      limit: pageSize,
    });

    return {
      items: page.items.map((row) => ({
        id: row.id,
        intentId: row.intentId,
        operation: row.operation,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Returns the ordered fee-bump decision history for one outbox entry, correlated
   * via the entry's envelope/tx hash (issue #661).
   */
  @Get(":id/fee-bumps")
  @ApiUnauthorizedResponse({ description: "Missing or invalid admin key" })
  @ApiNotFoundResponse({ description: "No outbox row with this id" })
  async feeBumps(@Param("id") id: string) {
    if (!/^\d+$/.test(id)) throw new NotFoundException(`No outbox row with id ${id}`);
    const row = await this.outbox.findById(id);
    if (!row) throw new NotFoundException(`No outbox row with id ${id}`);

    const hash = row.txHashOrEnvelopeHash;
    const decisions = hash ? await this.feeBumpDecisions.listByHash(hash) : [];

    return {
      id: row.id,
      txHashOrEnvelopeHash: hash ?? null,
      items: decisions.map((d) => ({
        feeBumpCount: d.feeBumpCount,
        percentileUsed: d.percentileUsed,
        newFeeStroops: d.newFeeStroops,
        ceilingHit: d.ceilingHit,
        decidedAt: d.decidedAt,
      })),
    };
  }

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
