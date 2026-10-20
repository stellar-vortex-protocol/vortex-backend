/**
 * AbuseController — admin/transparency endpoints for the abuse detector.
 *
 * GET  /api/v1/abuse/audit/:address  → last N events for a user (admin only)
 * GET  /api/v1/abuse/score/:address  → latest cached score for a user
 * POST /api/v1/abuse/reset/:address  → clear score + audit for a user (admin only)
 * GET    /api/v1/abuse/rules          → effective rule configuration (admin only)
 * PATCH  /api/v1/abuse/rules/:signal  → override one rule's fields at runtime (admin only)
 * DELETE /api/v1/abuse/rules/:signal  → drop a rule's overrides, back to env/defaults (admin only)
 *
 * These routes require the `X-Admin-Key` header (same mechanism as
 * AdminModule); they are NOT gated by the abuse detector itself so an operator
 * can always reach them even when Redis is degraded.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiOkResponse, ApiQuery, ApiParam, ApiBody } from "@nestjs/swagger";
import { AbuseRuleChange, AbuseScoreService } from "./abuse-score.service";
import { AbuseAuditEvent, AbuseRulesConfig, AbuseSignal } from "./abuse.types";
import {
  ABUSE_SIGNALS,
  AbuseRuleValidationError,
  RuleFieldValue,
  isAbuseSignal,
  validateRulePatch,
} from "./abuse-rules";

@ApiTags("abuse")
@Controller({ path: "abuse", version: "1" })
export class AbuseController {
  private readonly logger = new Logger(AbuseController.name);

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

  /** Effective configuration of every rule (persisted > env > defaults). */
  @Get("rules")
  @ApiOperation({ summary: "Effective abuse rule configuration (admin)" })
  @ApiOkResponse({ description: "AbuseRulesConfig keyed by signal" })
  getRules(@Headers("x-admin-key") adminKey?: string): AbuseRulesConfig {
    this.requireAdminKey(adminKey);
    return this.scorer.getRules();
  }

  /**
   * Override one rule's fields. Takes effect on the next request without a
   * restart and survives restarts. Only fields the rule already has are
   * accepted: `enabled` (boolean) and non-negative numbers for the rest.
   */
  @Patch("rules/:signal")
  @ApiOperation({ summary: "Update one abuse rule at runtime (admin)" })
  @ApiParam({ name: "signal", enum: ABUSE_SIGNALS })
  @ApiBody({
    schema: { type: "object", additionalProperties: true, example: { weight: 25, maxDustUsd: 0.005 } },
  })
  @ApiOkResponse({ description: "The rule before and after the change" })
  async patchRule(
    @Param("signal") signal: string,
    @Body() body: unknown,
    @Headers("x-admin-key") adminKey?: string,
  ): Promise<AbuseRuleChange> {
    this.requireAdminKey(adminKey);
    const rule = this.requireSignal(signal);
    let patch: Record<string, RuleFieldValue>;
    try {
      patch = validateRulePatch(rule, body);
    } catch (err) {
      if (err instanceof AbuseRuleValidationError) throw new BadRequestException(err.problems);
      throw err;
    }
    return this.persist(() => this.scorer.updateRule(rule, patch));
  }

  /** Remove every override for a rule, reverting it to env/default values. */
  @Delete("rules/:signal")
  @ApiOperation({ summary: "Reset one abuse rule to its env/default configuration (admin)" })
  @ApiParam({ name: "signal", enum: ABUSE_SIGNALS })
  @ApiOkResponse({ description: "The rule before and after the reset" })
  async resetRule(
    @Param("signal") signal: string,
    @Headers("x-admin-key") adminKey?: string,
  ): Promise<AbuseRuleChange> {
    this.requireAdminKey(adminKey);
    const rule = this.requireSignal(signal);
    return this.persist(() => this.scorer.resetRule(rule));
  }

  private requireSignal(signal: string): AbuseSignal {
    if (!isAbuseSignal(signal)) {
      throw new NotFoundException(`Unknown abuse rule "${signal}". Expected one of: ${ABUSE_SIGNALS.join(", ")}`);
    }
    return signal;
  }

  /** Map a persistence failure to 503: the change was not applied. */
  private async persist(change: () => Promise<AbuseRuleChange>): Promise<AbuseRuleChange> {
    try {
      return await change();
    } catch (err) {
      this.logger.error(`[abuse-rules] could not persist rule change: ${(err as Error).message}`);
      throw new ServiceUnavailableException("Rule store unavailable; the change was not applied");
    }
  }

  private requireAdminKey(key?: string): void {
    const expected = process.env.KILLSWITCH_OPERATOR_TOKEN ?? "";
    if (!expected || key !== expected) {
      throw new ForbiddenException("Admin key required");
    }
  }
}
