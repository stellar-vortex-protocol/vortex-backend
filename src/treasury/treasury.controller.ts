import {
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
} from "@nestjs/swagger";
import { TreasuryService } from "./treasury.service";
import { ReconciliationSummary, ReconciliationDetailResponse } from "./treasury.types";

/**
 * TreasuryController
 * 
 * Public and admin endpoints for treasury reconciliation data.
 */
@ApiTags("treasury")
@Controller("api/v1/treasury")
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
}
