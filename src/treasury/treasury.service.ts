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
        slashes: expected.totalSlashes,
        refunds: expected.totalRefunds,
      },
    };

    // Save snapshot to database
    await this.prisma.treasurySnapshot.upsert({
      where: {
        snapshot_date_asset_unique: {
          snapshotDate,
          asset,
        },
      },
      create: {
        snapshotDate,
        asset,
        expectedBalance: expected.netExpected,
        actualBalance: actual.balance,
        discrepancy: discrepancy.toString(),
        toleranceThreshold: tolerance.toString(),
        hasUnexplainedDiscrepancy,
        explanation,
        breakdown: result.breakdown,
      },
      update: {
        expectedBalance: expected.netExpected,
        actualBalance: actual.balance,
        discrepancy: discrepancy.toString(),
        hasUnexplainedDiscrepancy,
        explanation,
        breakdown: result.breakdown,
      },
    });

    // Alert on unexplained discrepancies
    if (hasUnexplainedDiscrepancy) {
      await this.alertDiscrepancy(result);
    }

    return result;
  }

  /**
   * Generate human-readable explanation for discrepancies
   */
  private generateExplanation(
    discrepancy: bigint,
    hasUnexplainedDiscrepancy: boolean,
    asset: string,
  ): string | null {
    if (discrepancy === 0n) {
      return "Balances match exactly.";
    }

    if (!hasUnexplainedDiscrepancy) {
      return `Discrepancy within tolerance threshold. Likely due to in-flight settlements or pending transactions.`;
    }

    const direction = discrepancy > 0n ? "higher" : "lower";
    return `Treasury balance is ${direction} than expected by ${discrepancy.toString()} base units. This exceeds the tolerance threshold and requires investigation.`;
  }

  /**
   * Perform daily reconciliation for all tracked assets
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async performDailyReconciliation(): Promise<void> {
    this.logger.log("Starting daily treasury reconciliation");

    try {
      // Get all unique assets from ledgers
      const assetsFromFees = await this.prisma.feeLedger.findMany({
        select: { asset: true },
        distinct: ["asset"],
      });
      
      const assetsFromSlashes = await this.prisma.slashLedger.findMany({
        select: { asset: true },
        distinct: ["asset"],
      });

      const allAssets = new Set([
        ...assetsFromFees.map((f) => f.asset),
        ...assetsFromSlashes.map((s) => s.asset),
      ]);

      const results: ReconciliationResult[] = [];
      
      for (const asset of allAssets) {
        try {
          const result = await this.reconcileAsset(asset);
          results.push(result);
        } catch (error) {
          this.logger.error(`Failed to reconcile asset ${asset}:`, error);
        }
      }

      const withDiscrepancies = results.filter((r) => r.hasUnexplainedDiscrepancy);
      
      this.logger.log(
        `Daily reconciliation complete. ${results.length} assets checked, ` +
        `${withDiscrepancies.length} with unexplained discrepancies.`,
      );
    } catch (error) {
      this.logger.error("Daily reconciliation failed:", error);
      throw error;
    }
  }

  /**
   * Get reconciliation summary for a specific date
   */
  async getReconciliationSummary(date?: string): Promise<ReconciliationSummary> {
    const snapshotDate = date || new Date().toISOString().split("T")[0];

    const snapshots = await this.prisma.treasurySnapshot.findMany({
      where: { snapshotDate },
      orderBy: { asset: "asc" },
    });

    const assets: ReconciliationResult[] = snapshots.map((s) => ({
      snapshotDate: s.snapshotDate,
      asset: s.asset,
      expectedBalance: s.expectedBalance,
      actualBalance: s.actualBalance,
      discrepancy: s.discrepancy,
      discrepancyPercentage: this.calculatePercentage(
        BigInt(s.discrepancy),
        BigInt(s.expectedBalance),
      ),
      toleranceThreshold: s.toleranceThreshold,
      hasUnexplainedDiscrepancy: s.hasUnexplainedDiscrepancy,
      explanation: s.explanation,
      breakdown: s.breakdown as any,
    }));

    return {
      date: snapshotDate,
      assets,
      totalDiscrepancies: assets.filter((a) => BigInt(a.discrepancy) !== 0n).length,
      assetsWithUnexplainedDiscrepancies: assets.filter(
        (a) => a.hasUnexplainedDiscrepancy,
      ).length,
      lastReconciliationAt: snapshots[0]?.createdAt.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * Get detailed reconciliation for a specific asset
   */
  async getReconciliationDetail(
    asset: string,
    date?: string,
  ): Promise<ReconciliationDetailResponse> {
    const snapshotDate = date || new Date().toISOString().split("T")[0];

    const snapshot = await this.prisma.treasurySnapshot.findUnique({
      where: {
        snapshot_date_asset_unique: {
          snapshotDate,
          asset,
        },
      },
    });

    if (!snapshot) {
      throw new Error(`No reconciliation found for asset ${asset} on ${snapshotDate}`);
    }

    // Fetch recent transactions (last 100 of each type)
    const [fees, slashes, refunds] = await Promise.all([
      this.prisma.feeLedger.findMany({
        where: { asset },
        orderBy: { accrualAt: "desc" },
        take: 100,
      }),
      this.prisma.slashLedger.findMany({
        where: { asset },
        orderBy: { slashedAt: "desc" },
        take: 100,
      }),
      this.prisma.refundLedger.findMany({
        where: { asset },
        orderBy: { issuedAt: "desc" },
        take: 100,
      }),
    ]);

    const recentTransactions = [
      ...fees.map((f) => ({
        type: "fee" as const,
        amount: f.amount,
        timestamp: f.accrualAt.toISOString(),
        reference: f.intentId,
      })),
      ...slashes.map((s) => ({
        type: "slash" as const,
        amount: s.amount,
        timestamp: s.slashedAt.toISOString(),
        reference: s.solverAddress,
      })),
      ...refunds.map((r) => ({
        type: "refund" as const,
        amount: r.amount,
        timestamp: r.issuedAt.toISOString(),
        reference: r.intentId,
      })),
    ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return {
      snapshotDate: snapshot.snapshotDate,
      asset: snapshot.asset,
      expectedBalance: snapshot.expectedBalance,
      actualBalance: snapshot.actualBalance,
      discrepancy: snapshot.discrepancy,
      discrepancyPercentage: this.calculatePercentage(
        BigInt(snapshot.discrepancy),
        BigInt(snapshot.expectedBalance),
      ),
      toleranceThreshold: snapshot.toleranceThreshold,
      hasUnexplainedDiscrepancy: snapshot.hasUnexplainedDiscrepancy,
      explanation: snapshot.explanation,
      breakdown: snapshot.breakdown as any,
      recentTransactions,
    };
  }

  /**
   * Calculate percentage from bigints
   */
  private calculatePercentage(discrepancy: bigint, expected: bigint): number {
    if (expected === 0n) return 0;
    return Number((discrepancy * 10000n) / expected) / 100;
  }

  /**
   * Alert on unexplained discrepancies
   */
  private async alertDiscrepancy(result: ReconciliationResult): Promise<void> {
    const severity = this.getSeverity(result);
    
    this.logger.warn(
      `[${severity.toUpperCase()}] Treasury discrepancy detected for ${result.asset}: ` +
      `${result.discrepancy} base units (${result.discrepancyPercentage.toFixed(2)}%)`,
    );

    // TODO: Integrate with alerting system (PagerDuty, Slack, etc.)
    // For now, just log the alert
  }

  /**
   * Determine severity of discrepancy
   */
  private getSeverity(result: ReconciliationResult): "warning" | "critical" {
    const absPercentage = Math.abs(result.discrepancyPercentage);
    
    // Critical if discrepancy > 5%
    if (absPercentage > 5) {
      return "critical";
    }
    
    return "warning";
  }

  /**
   * Manual reconciliation trigger (admin use)
   */
  async triggerReconciliation(asset?: string): Promise<ReconciliationResult[]> {
    if (asset) {
      const result = await this.reconcileAsset(asset);
      return [result];
    }

    // Reconcile all assets
    await this.performDailyReconciliation();
    
    const summary = await this.getReconciliationSummary();
    return summary.assets;
  }
}
