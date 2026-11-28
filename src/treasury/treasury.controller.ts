import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiHeader,
} from "@nestjs/swagger";
import { IsString, MinLength, MaxLength } from "class-validator";
import { TreasuryService } from "./treasury.service";
import { ReconciliationSummary, ReconciliationDetailResponse } from "./treasury.types";
import { AdminGuard, CurrentAdmin, RequireAdminRole } from "../admin/admin.guard";
import { AdminPrincipal } from "../admin/admin-auth";

export class AcknowledgeAlertDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  note?: string;
}

/**
 * TreasuryController
 * 
 * Public and admin endpoints for treasury reconciliation data.
 */
@ApiTags("treasury")
@Controller({ path: "treasury", version: "1" })
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  /**
   * GET /api/v1/treasury/reconciliation
   * 
   * Public summary of treasury reconciliation for a given date.
   * Returns high-level stats on expected vs actual balances.
   */
  @Get("reconciliation")
  @ApiOperation({
    summary: "Get treasury reconciliation summary",
    description: "Returns daily reconciliation summary showing expected vs actual balances per asset",
  })
  @ApiQuery({
    name: "date",
    required: false,
    description: "Date in YYYY-MM-DD format (defaults to today)",
    example: "2026-09-28",
  })
  @ApiResponse({
    status: 200,
    description: "Reconciliation summary",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", example: "2026-09-28" },
        assets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              asset: { type: "string", example: "native" },
              expectedBalance: { type: "string", example: "1000000000" },
              actualBalance: { type: "string", example: "1000500000" },
              discrepancy: { type: "string", example: "500000" },
              discrepancyPercentage: { type: "number", example: 0.05 },
              hasUnexplainedDiscrepancy: { type: "boolean", example: false },
              explanation: { type: "string", nullable: true },
            },
          },
        },
        totalDiscrepancies: { type: "number", example: 3 },
        assetsWithUnexplainedDiscrepancies: { type: "number", example: 1 },
        lastReconciliationAt: { type: "string", example: "2026-09-28T00:00:00.000Z" },
      },
    },
  })
  async getReconciliation(
    @Query("date") date?: string,
  ): Promise<ReconciliationSummary> {
    return this.treasuryService.getReconciliationSummary(date);
  }

  /**
   * GET /api/v1/treasury/reconciliation/:asset
   * 
   * Detailed reconciliation view for a specific asset (admin).
   * Includes breakdown and recent transactions.
   */
  @Get("reconciliation/:asset")
  @ApiOperation({
    summary: "Get detailed reconciliation for an asset",
    description: "Returns detailed reconciliation data including transaction breakdown",
  })
  @ApiParam({
    name: "asset",
    description: "Asset identifier (e.g., 'native', 'USDC:ISSUER', or contract address)",
    example: "native",
  })
  @ApiQuery({
    name: "date",
    required: false,
    description: "Date in YYYY-MM-DD format (defaults to today)",
    example: "2026-09-28",
  })
  @ApiResponse({
    status: 200,
    description: "Detailed reconciliation data",
    schema: {
      type: "object",
      properties: {
        snapshotDate: { type: "string", example: "2026-09-28" },
        asset: { type: "string", example: "native" },
        expectedBalance: { type: "string", example: "1000000000" },
        actualBalance: { type: "string", example: "1000500000" },
        discrepancy: { type: "string", example: "500000" },
        discrepancyPercentage: { type: "number", example: 0.05 },
        toleranceThreshold: { type: "string", example: "10000000" },
        hasUnexplainedDiscrepancy: { type: "boolean", example: false },
        explanation: { type: "string", nullable: true },
        breakdown: {
          type: "object",
          properties: {
            fees: { type: "string", example: "500000000" },
            slashes: { type: "string", example: "100000000" },
            refunds: { type: "string", example: "50000000" },
          },
        },
        recentTransactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["fee", "slash", "refund"] },
              amount: { type: "string", example: "1000000" },
              timestamp: { type: "string", example: "2026-09-28T12:00:00.000Z" },
              reference: { type: "string", example: "intent-uuid" },
            },
          },
        },
      },
    },
  })
  async getAssetReconciliation(
    @Param("asset") asset: string,
    @Query("date") date?: string,
  ): Promise<ReconciliationDetailResponse> {
    return this.treasuryService.getReconciliationDetail(asset, date);
  }

  /**
   * POST /api/v1/treasury/reconciliation/trigger
   * 
   * Manually trigger reconciliation (admin only).
   * Useful for testing or ad-hoc checks.
   */
  @Post("reconciliation/trigger")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Manually trigger treasury reconciliation",
    description: "Admin endpoint to trigger reconciliation on-demand",
  })
  @ApiQuery({
    name: "asset",
    required: false,
    description: "Specific asset to reconcile (reconciles all if omitted)",
    example: "native",
  })
  @ApiResponse({
    status: 200,
    description: "Reconciliation completed",
    schema: {
      type: "object",
      properties: {
        message: { type: "string", example: "Reconciliation completed" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              asset: { type: "string" },
              hasUnexplainedDiscrepancy: { type: "boolean" },
              discrepancy: { type: "string" },
            },
          },
        },
      },
    },
  })
  // TODO: Add admin guard - @UseGuards(AdminGuard)
  async triggerReconciliation(@Query("asset") asset?: string) {
    const results = await this.treasuryService.triggerReconciliation(asset);
    
    return {
      message: asset
        ? `Reconciliation completed for ${asset}`
        : "Reconciliation completed for all assets",
      results: results.map((r) => ({
        asset: r.asset,
        hasUnexplainedDiscrepancy: r.hasUnexplainedDiscrepancy,
        discrepancy: r.discrepancy,
        discrepancyPercentage: r.discrepancyPercentage,
      })),
    };
  }

  /**
   * GET /api/v1/treasury/alerts
   *
   * List persisted treasury discrepancy alerts. Filterable by acknowledged
   * status, asset, and severity.
   */
  @Get("alerts")
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "List treasury discrepancy alerts" })
  @ApiQuery({ name: "acknowledged", required: false, enum: ["true", "false"] })
  @ApiQuery({ name: "asset", required: false, type: String })
  @ApiQuery({ name: "severity", required: false, enum: ["warning", "critical"] })
  async listAlerts(
    @Query("acknowledged") acknowledged?: string,
    @Query("asset") asset?: string,
    @Query("severity") severity?: string,
  ) {
    const ackFilter =
      acknowledged === "true" ? true : acknowledged === "false" ? false : undefined;
    return this.treasuryService.listAlerts({ acknowledged: ackFilter, asset, severity });
  }

  /**
   * POST /api/v1/treasury/alerts/:id/acknowledge
   *
   * Acknowledge a treasury alert. Idempotent.
   */
  @Post("alerts/:id/acknowledge")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminGuard)
  @RequireAdminRole("admin")
  @ApiHeader({ name: "x-admin-key", required: true })
  @ApiOperation({ summary: "Acknowledge a treasury alert" })
  @ApiParam({ name: "id", description: "Treasury alert id (UUID)" })
  async acknowledgeAlert(
    @Param("id") id: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return this.treasuryService.acknowledgeAlert(id, admin.id);
  }
}
