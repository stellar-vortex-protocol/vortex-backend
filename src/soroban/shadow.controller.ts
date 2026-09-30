import { Controller, Get, Query } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { MAX_SHADOW_REPORT_DAYS, ShadowService } from "./shadow.service";
import { ShadowReport } from "./shadow.types";

/**
 * Query parameters for `GET /api/v1/admin/shadow-report`.
 *
 * A class rather than a bare `@Query() number` so the value is coerced and
 * range-checked by the global `ValidationPipe` instead of by hand: the endpoint
 * answers 400 for `?days=abc` or `?days=10000` rather than silently serving a
 * clamped answer. `ShadowService.report` clamps independently as defence in
 * depth, so a future caller that bypasses the pipe still gets a usable report
 * rather than an unbounded scan.
 */
export class ShadowReportQueryDto {
  /**
   * How many trailing UTC days of per-day breakdown to include.
   *
   * @default 1
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "days must be an integer" })
  @Min(1, { message: "days must be at least 1" })
  @Max(MAX_SHADOW_REPORT_DAYS, {
    message: `days must not exceed ${MAX_SHADOW_REPORT_DAYS} (the report's retention window)`,
  })
  days?: number;
}

/**
 * Read-only operational endpoints for the shadow-mode divergence monitor
 * (issue #401).
 *
 * Deliberately mounted under `/api/v1/admin` and documented as unauthenticated
 * *only* because the whole `/api/v1` surface is currently unauthenticated in
 * this service. The payload contains no keys, no XDR and no user addresses
 * beyond intent IDs, but if an auth layer is ever added this controller
 * should be the first thing behind it — an operator-facing endpoint that
 * describes internal consistency is not something to expose publicly.
 */
@ApiTags("admin")
@Controller("api/v1/admin")
export class ShadowController {
  constructor(private readonly shadowService: ShadowService) {}

  /**
   * GET /api/v1/admin/shadow-report
   *
   * Daily summary of the shadow-mode divergence monitor: how many
   * transitions were compared against an on-chain simulation, how many
   * diverged and why, and whether the monitor itself is healthy (queue depth,
   * drops, sample-out count).
   *
   * This is the number the on-chain cutover runbook quotes as the go/no-go
   * threshold — see the "Shadow-mode go/no-go" section of
   * `docs/runbooks/onchain-cutover.md`.
   */
  @Get("shadow-report")
  @ApiOperation({
    summary: "Daily shadow-mode divergence summary",
    description:
      "Returns (expected, simulated) comparison counts for on-chain simulations run " +
      "in parallel with the off-chain intent path, broken down by transition and by " +
      "divergence reason, plus a per-UTC-day series and shadow queue health. Headline " +
      "totals are lifetime-to-date; `days` bounds only the per-day breakdown.",
  })
  @ApiQuery({
    name: "days",
    required: false,
    type: Number,
    description: `Trailing UTC days of per-day breakdown to include (1-${MAX_SHADOW_REPORT_DAYS}, default 1).`,
  })
  @ApiOkResponse({
    description: "Shadow-mode divergence report",
    schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        sampleRate: { type: "number" },
        day: { type: "string", example: "2026-09-30" },
        generatedAt: { type: "string", format: "date-time" },
        compared: { type: "number" },
        diverged: { type: "number" },
        divergenceRate: { type: "number" },
        transitions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              transition: { type: "string", example: "accept" },
              compared: { type: "number" },
              diverged: { type: "number" },
              divergenceRate: { type: "number" },
            },
          },
        },
        divergences: {
          type: "array",
          items: {
            type: "object",
            properties: {
              transition: { type: "string", example: "fill" },
              reason: {
                type: "string",
                example: "outcome_mismatch",
                enum: [
                  "outcome_mismatch",
                  "simulation_error",
                  "simulation_exception",
                  "contract_unconfigured",
                ],
              },
              count: { type: "number" },
            },
          },
        },
        daily: {
          type: "array",
          items: {
            type: "object",
            properties: {
              day: { type: "string", example: "2026-09-30" },
              compared: { type: "number" },
              diverged: { type: "number" },
              divergenceRate: { type: "number" },
              cells: { type: "array", items: { type: "object" } },
            },
          },
        },
        queue: {
          type: "object",
          properties: {
            depth: { type: "number" },
            capacity: { type: "number" },
            dropped: { type: "number" },
            sampledOut: { type: "number" },
            disabled: { type: "number" },
            completed: { type: "number" },
          },
        },
      },
    },
  })
  shadowReport(@Query() query: ShadowReportQueryDto): ShadowReport {
    return this.shadowService.report(query.days ?? 1);
  }
}
