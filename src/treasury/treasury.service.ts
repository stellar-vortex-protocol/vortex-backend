import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { SorobanService } from "../soroban/soroban.service";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  AssetBalance,
  ExpectedBalance,
  ReconciliationResult,
  ReconciliationSummary,
  ReconciliationDetailResponse,
  FeeLedgerEntry,
  SlashLedgerEntry,
  RefundLedgerEntry,
  SlashAttribution,
} from "./treasury.types";
import { AppConfig } from "../config/configuration";

/**
 * TreasuryService
 * 
 * Aggregates fee-ledger accruals, slash proceeds, and refunds,
 * and reconciles them daily against actual on-chain treasury balances.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly treasuryAddress: string;
  private readonly toleranceThresholds: Map<string, bigint>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {
    const horizonUrl = this.configService.get("stellar.horizonUrl", { infer: true });
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);
    
    this.treasuryAddress = this.configService.get("treasury.address", { infer: true });
    
    // Default tolerance thresholds per asset (in base units)
    // Could be moved to config/database
    this.toleranceThresholds = new Map([
      ["native", 10000000n], // 1 XLM (7 decimals)
      ["USDC", 1000000n],     // 1 USDC (6 decimals)
    ]);
  }

  /**
   * Record a fee accrual in the ledger
   */
  async recordFee(entry: FeeLedgerEntry): Promise<void> {
    await this.prisma.feeLedger.create({
      data: {
        intentId: entry.intentId,
        asset: entry.asset,
        amount: entry.amount,
        accrualAt: entry.accrualAt,
        txHash: entry.txHash,
      },
    });
    
    this.logger.log(`Recorded fee: ${entry.amount} ${entry.asset} for intent ${entry.intentId}`);
  }

  /**
   * Record a slash in the ledger
   */
  async recordSlash(entry: SlashLedgerEntry): Promise<void> {
    await this.prisma.slashLedger.create({
      data: {
        solverAddress: entry.solverAddress,
        asset: entry.asset,
        amount: entry.amount,
        slashedAt: entry.slashedAt,
        reason: entry.reason,
        txHash: entry.txHash,
      },
    });
    
    this.logger.log(`Recorded slash: ${entry.amount} ${entry.asset} from solver ${entry.solverAddress}`);
  }

  /**
   * Record a refund in the ledger
   */
  async recordRefund(entry: RefundLedgerEntry): Promise<void> {
    await this.prisma.refundLedger.create({
      data: {
        intentId: entry.intentId,
        userAddress: entry.userAddress,
        asset: entry.asset,
        amount: entry.amount,
        issuedAt: entry.issuedAt,
        reason: entry.reason,
        txHash: entry.txHash,
      },
    });
    
    this.logger.log(`Recorded refund: ${entry.amount} ${entry.asset} to user ${entry.userAddress}`);
  }

  /**
   * Attribute treasury slash inflow to the solver it came from.
   *
   * Groups `slashLedger` rows by `solverAddress` (and `asset`) via a single
   * grouped Prisma query, returning a per-asset breakdown per solver so that
   * multi-asset totals are never blended into one number.
   */
  async getSlashAttribution(
    asset?: string,
    from?: Date,
    to?: Date,
  ): Promise<SlashAttribution[]> {
    const where: {
      asset?: string;
      slashedAt?: { gte?: Date; lte?: Date };
    } = {};

    if (asset) {
      where.asset = asset;
    }

    if (from || to) {
      where.slashedAt = {};
      if (from) {
        where.slashedAt.gte = from;
      }
      if (to) {
        where.slashedAt.lte = to;
      }
    }

    const grouped = await this.prisma.slashLedger.groupBy({
      by: ["solverAddress", "asset"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });

    const bySolver = new Map<string, SlashAttribution>();

    for (const row of grouped) {
      const solverAddress = row.solverAddress;
      const rowAsset = row.asset;
      const total = BigInt(row._sum.amount ?? 0);
      const count = row._count._all;

      let attribution = bySolver.get(solverAddress);
      if (!attribution) {
        attribution = {
          solverAddress,
          totalSlashed: "0",
          entryCount: 0,
          byAsset: {},
        };
        bySolver.set(solverAddress, attribution);
      }

      attribution.byAsset[rowAsset] = {
        totalSlashed: total.toString(),
        entryCount: count,
      };
      attribution.entryCount += count;
    }

    // Sort descending by total slashed. When multiple assets are present we
    // cannot blend units, so rank by the largest single-asset total per solver.
    const results = Array.from(bySolver.values());
    for (const attribution of results) {
      let max = 0n;
      for (const breakdown of Object.values(attribution.byAsset)) {
        const value = BigInt(breakdown.totalSlashed);
        if (value > max) {
          max = value;
        }
      }
      attribution.totalSlashed = max.toString();
    }

    results.sort((a, b) => {
      const diff = BigInt(b.totalSlashed) - BigInt(a.totalSlashed);
      if (diff > 0n) return 1;
      if (diff < 0n) return -1;
      return 0;
    });

    return results;
  }

  /**
   * Calculate expected treasury balance from ledgers
   */
  async calculateExpectedBalance(asset: string, untilDate?: Date): Promise<ExpectedBalance> {
    const until = untilDate || new Date();

    // Aggregate fees
    const fees = await this.prisma.feeLedger.findMany({
      where: {
        asset,
        accrualAt: { lte: until },
      },
    });
    const totalFees = fees.reduce((sum, f) => sum + BigInt(f.amount), 0n);

    // Aggregate slashes
    const slashes = await this.prisma.slashLedger.findMany({
      where: {
        asset,
        slashedAt: { lte: until },
      },
    });
    const totalSlashes = slashes.reduce((sum, s) => sum + BigInt(s.amount), 0n);

    // Aggregate refunds
    const refunds = await this.prisma.refundLedger.findMany({
      where: {
        asset,
        issuedAt: { lte: until },
      },
    });
    const totalRefunds = refunds.reduce((sum, r) => sum + BigInt(r.amount), 0n);

    const netExpected = totalFees + totalSlashes - totalRefunds;

    return {
      asset,
      totalFees: totalFees.toString(),
      totalSlashes: totalSlashes.toString(),
      totalRefunds: totalRefunds.toString(),
      netExpected: netExpected.toString(),
    };
  }

  /**
   * Fetch actual on-chain balance for treasury account
   */
  async fetchActualBalance(asset: string): Promise<AssetBalance> {
    try {
      const account = await this.horizonServer.loadAccount(this.treasuryAddress);
      
      // Handle native XLM
      if (asset === "native") {
        const balance = account.balances.find((b) => b.asset_type === "native");
        return {
          asset: "native",
          balance: balance ? this.parseBalance(balance.balance) : "0",
        };
      }

      // Handle issued assets (traditional Stellar assets)
      const [code, issuer] = asset.split(":");
      if (issuer) {
        const balance = account.balances.find(
          (b): b is typeof b & { asset_code: string; asset_issuer: string } =>
            b.asset_type !== "native" &&
            "asset_code" in b &&
            b.asset_code === code &&
            b.asset_issuer === issuer,
        );
        return {
          asset,
          balance: balance ? this.parseBalance(balance.balance) : "0",
        };
      }

      // Handle Soroban tokens (SAC balances)
      // This would require calling a Soroban contract method
      // For now, return placeholder - implement based on your contract structure
      this.logger.warn(`Soroban asset balance fetch not yet implemented for ${asset}`);
      return {
        asset,
        balance: "0",
        contract: asset,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch balance for ${asset}:`, error);
      throw error;
    }
  }

  /**
   * Parse Horizon balance string to base units (stroops)
   */
  private parseBalance(balance: string): string {
    // Horizon returns balances as decimal strings like "100.0000000"
    // Convert to stroops (1 XLM = 10^7 stroops)
    const [whole, decimal = ""] = balance.split(".");
    const paddedDecimal = decimal.padEnd(7, "0");
    return (BigInt(whole) * 10000000n + BigInt(paddedDecimal)).toString();
  }

  /**
   * Perform reconciliation for a single asset
   */
  async reconcileAsset(
    asset: string,
    date: Date = new Date(),
  ): Promise<ReconciliationResult> {
    const snapshotDate = date.toISOString().split("T")[0];

    this.logger.log(`Reconciling asset ${asset} for date ${snapshotDate}`);

    // Calculate expected balance from ledgers
    const expected = await this.calculateExpectedBalance(asset, date);
    
    // Fetch actual on-chain balance
    const actual = await this.fetchActualBalance(asset);
    
    const expectedBigInt = BigInt(expected.netExpected);
    const actualBigInt = BigInt(actual.balance);
    const discrepancy = actualBigInt - expectedBigInt;
    const absDiscrepancy = discrepancy < 0n ? -discrepancy : discrepancy;
    
    const tolerance = this.toleranceThresholds.get(asset) || 0n;
    const hasUnexplainedDiscrepancy = absDiscrepancy > tolerance;
    
    // Calculate percentage
    const discrepancyPercentage = expectedBigInt > 0n
      ? Number((discrepancy * 10000n) / expectedBigInt) / 100
      : 0;

    // Generate explanation
    const explanation = this.generateExplanation(
      discrepancy,
      hasUnexplainedDiscrepancy,
      asset,
    );

    const result: ReconciliationResult = {
      snapshotDate,
      asset,
      expectedBalance: expected.netExpected,
      actualBalance: actual.balance,
      discrepancy: discrepancy.toString(),
      discrepancyPercentage,
      toleranceThreshold: tolerance.toString(),
      hasUnexplainedDiscrepancy,
      explanation,
      breakdown: {
        fees: expected.totalFees,
        slashes: expected.totalSlashes
      },
    };

    return result;
  }

  /**
   * Generate human-readable explanation for discrepancy
   */
  private generateExplanation(
    discrepancy: bigint,
    hasUnexplainedDiscrepancy: boolean,
    asset: string,
  ): string {
    if (discrepancy === 0n) {
      return "Balances match exactly";
    }

    if (!hasUnexplainedDiscrepancy) {
      return `Discrepancy of ${discrepancy} ${asset} is within tolerance`;
    }

    if (discrepancy > 0n) {
      return `Unexplained surplus of ${discrepancy} ${asset} - possible unrecorded fees or missing refund entries`;
    }

    return `Unexplained deficit of ${-discrepancy} ${asset} - possible unrecorded slashes or missing fee entries`;
  }

  /**
   * Run daily reconciliation for all configured assets
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runDailyReconciliation(): Promise<ReconciliationSummary> {
    this.logger.log("Starting daily treasury reconciliation");

    const assets = ["native", "USDC"];
    const results: ReconciliationResult[] = [];

    for (const asset of assets) {
      try {
        const result = await this.reconcileAsset(asset);
        results.push(result);
      } catch (error) {
        this.logger.error(`Failed to reconcile ${asset}:`, error);
      }
    }

    const summary: ReconciliationSummary = {
      timestamp: new Date().toISOString(),
      assets: results,
      allBalanced: results.every((r) => !r.hasUnexplainedDiscrepancy),
    };

    this.logger.log(
      `Reconciliation complete: ${summary.allBalanced ? "all balanced" : "discrepancies found"}`,
    );

    return summary;
  }

  /**
   * Get detailed reconciliation report for a date range
   */
  async getReconciliationDetail(
    asset: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<ReconciliationDetailResponse> {
    const fees = await this.prisma.feeLedger.findMany({
      where: {
        asset,
        accrualAt: { gte: fromDate, lte: toDate },
      },
      orderBy: { accrualAt: "asc" },
    });

    const slashes = await this.prisma.slashLedger.findMany({
      where: {
        asset,
        slashedAt: { gte: fromDate, lte: toDate },
      },
      orderBy: { slashedAt: "asc" },
    });

    const refunds = await this.prisma.refundLedger.findMany({
      where: {
        asset,
        issuedAt: { gte: fromDate, lte: toDate },
      },
      orderBy: { issuedAt: "asc" },
    });

    const totalFees = fees.reduce((sum, f) => sum + BigInt(f.amount), 0n);
    const totalSlashes = slashes.reduce((sum, s) => sum + BigInt(s.amount), 0n);
    const totalRefunds = refunds.reduce((sum, r) => sum + BigInt(r.amount), 0n);

    return {
      asset,
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      fees: fees.map((f) => ({
        intentId: f.intentId,
        amount: f.amount,
        accrualAt: f.accrualAt.toISOString(),
        txHash: f.txHash,
      })),
      slashes: slashes.map((s) => ({
        solverAddress: s.solverAddress,
        amount: s.amount,
        slashedAt: s.slashedAt.toISOString(),
        reason: s.reason,
        txHash: s.txHash,
      })),
      refunds: refunds.map((r) => ({
        intentId: r.intentId,
        userAddress: r.userAddress,
        amount: r.amount,
        issuedAt: r.issuedAt.toISOString(),
        reason: r.reason,
        txHash: r.txHash,
      })),
      totals: {
        fees: totalFees.toString(),
        slashes: totalSlashes.toString(),
        refunds: totalRefunds.toString(),
        net: (totalFees + totalSlashes - totalRefunds).toString(),
      },
    };
  }
}
