/**
 * AbuseController — admin/transparency endpoints for the abuse detector.
 *
 * GET  /api/v1/abuse/audit/:address  → last N events for a user (admin only)
 * GET  /api/v1/abuse/score/:address  → latest cached score for a user
 * POST /api/v1/abuse/reset/:address  → clear score + audit for a user (admin only)
 *
 * These routes require the `X-Admin-Key` header (same mechanism as
 * AdminModule); they are NOT gated by the abuse detector itself so an operator
 * can always reach them even when Redis is degraded.
 */

import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiOkResponse, ApiQuery } from "@nestjs/swagger";
import { AbuseScoreService } from "./abuse-score.service";
import { AbuseAuditEvent } from "./abuse.types";

@ApiTags("abuse")
@Controller("api/v1/abuse")
export class AbuseController {
  constructor(private readonly scorer: AbuseScoreService) {}

  /**
   * Returns the last `limit` (default 20, max 100) audit events for the
   * specified user address.
   *
   * Requires `X-Admin-Key` header (operator token).
   */
  @Get("audit/:address")
  @ApiOperation({ summary: "Abuse audit history for a user address (admin)" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiOkResponse({ description: "Array of AbuseAuditEvent" })
  async getAuditHistory(
    @Param("address") address: string,
    @Query("limit") limitRaw?: string,
    @Headers("x-admin-key") adminKey?: string,
  ): Promise<{ address: string; events: AbuseAuditEvent[] }> {
    this.requireAdminKey(adminKey);
    const limit = Math.min(parseInt(limitRaw ?? "20", 10) || 20, 100);
    const events = await this.scorer.getAuditHistory(address, limit);
    return { address, events };
  }

  /**
   * Returns the latest cached abuse score for an address.
   * Open to authenticated callers (admin key required for raw score access).
   */
  @Get("score/:address")
  @ApiOperation({ summary: "Latest cached abuse score for a user address" })
  @ApiOkResponse({ description: "Score object" })
  async getScore(
    @Param("address") address: string,
    @Headers("x-admin-key") adminKey?: string,
  ): Promise<{ address: string; score: number | null }> {
    this.requireAdminKey(adminKey);
    const score = await this.scorer.getCachedScore(address);
    return { address, score };
  }

  private requireAdminKey(key?: string): void {
    const expected = process.env.KILLSWITCH_OPERATOR_TOKEN ?? "";
    if (!expected || key !== expected) {
      throw new ForbiddenException("Admin key required");
    }
  }
}
