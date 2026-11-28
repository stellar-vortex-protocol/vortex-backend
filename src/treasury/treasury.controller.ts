import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
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

/** Maximum number of days allowed in a reconciliation history range. */
const MAX_RECONCILIATION_HISTORY_DAYS = 180;

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
   * GET /api/v1/treasury/reconciliation/:asset/history
   *
   * Historical trend of treasury snapshots for a specific asset across a
   * bounded date range. Returns rows ordered by snapshotDate ascending so a
   * frontend can chart discrepancy-over-time without one request per day.
   */
  @Get("reconciliation/:asset/history")
  @ApiOperation({
    summary: "Get reconciliation history for an asset",
    description:
      "Returns the ordered treasury snapshot series for an asset across a bounded date range",
  })
  @ApiParam({
    name: "asset",
    description: "Asset identifier (e.g., 'native', 'USDC:ISSUER', or contract address)",
    example: "native",
  })
  @ApiQuery({
    name: "from",
    required: true,
    description: "Start date in YYYY-MM-DD format (inclusive)",
    example: "2026-04-01",
  })
  @ApiQuery({
    name: "to",
    required: true,
    description: "End date in YYYY-MM-DD format (inclusive)",
    example: "2026-09-28",
  })
  @ApiResponse({
    status: 200,
    description: "Ordered reconciliation snapshot series",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          snapshotDate: { type: "string", example: "2026-09-28" },
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
  })
  @ApiResponse({ status: 400, description: "Invalid or over-length date range" })
  async getAssetReconciliationHistory(
    @Param("asset") asset: string,
    @Query("from") from: string,
    @Query("to") to: string,
  ): Promise<ReconciliationDetailResponse[]> {
    const fromDate = this.parseDateParam("from", from);
    const toDate = this.parseDateParam("to", to);

    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException("'from' must be on or before 'to'");
    }

    const rangeDays =
      Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
    if (rangeDays > MAX_RECONCILIATION_HISTORY_DAYS) {
      throw new BadRequestException(
        `Date range must not exceed ${MAX_RECONCILIATION_HISTORY_DAYS} days`,
      );
    }

    return this.treasuryService.getReconciliationHistory(asset, from, to);
  }

  /**
   * Parse a YYYY-MM-DD query param into a UTC Date, rejecting malformed input.
   */
  private parseDateParam(name: string, value: string): Date {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(
        `'${name}' must be a valid date in YYYY-MM-DD format`,
      );
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `'${name}' must be a valid date in YYYY-MM-DD format`,
      );
    }
    return parsed;
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
