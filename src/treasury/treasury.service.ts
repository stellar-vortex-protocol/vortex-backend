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

    // Persist snapshot
    await this.prisma.treasurySnapshot.create({
      data: {
        snapshotDate: new Date(snapshotDate),
        asset,
        expectedBalance: result.expectedBalance,
        actualBalance: result.actualBalance,
        discrepancy: result.discrepancy,
        discrepancyPercentage: result.discrepancyPercentage,
        toleranceThreshold: result.toleranceThreshold,
        hasUnexplainedDiscrepancy: result.hasUnexplainedDiscrepancy,
        explanation: result.explanation,
        breakdown: result.breakdown as any,
      },
    });

    if (hasUnexplainedDiscrepancy) {
      this.logger.warn(
        `Unexplained discrepancy for ${asset} on ${snapshotDate}: ${discrepancy.toString()} (${discrepancyPercentage}%)`,
      );
    } else {
      this.logger.log(`Reconciliation OK for ${asset} on ${snapshotDate}`);
    }

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
      return "Perfect reconciliation - no discrepancy";
    }

    if (!hasUnexplainedDiscrepancy) {
      return `Discrepancy of ${discrepancy.toString()} ${asset} is within tolerance threshold`;
    }

    if (discrepancy > 0n) {
      return `Unexplained surplus of ${discrepancy.toString()} ${asset} - actual balance exceeds expected`;
    }

    return `Unexplained deficit of ${(-discrepancy).toString()} ${asset} - expected balance exceeds actual`;
  }

  /**
   * Get reconciliation history for a date range
   */
  async getReconciliationHistory(
    from: Date,
    to: Date,
    asset?: string,
  ): Promise<ReconciliationResult[]> {
    const snapshots = await this.prisma.treasurySnapshot.findMany({
      where: {
        snapshotDate: {
          gte: from,
          lte: to,
        },
        ...(asset ? { asset } : {}),
      },
      orderBy: { snapshotDate: "asc" },
    });

    return snapshots.map((s) => ({
      snapshotDate: s.snapshotDate.toISOString().split("T")[0],
      asset: s.asset,
      expectedBalance: s.expectedBalance,
      actualBalance: s.actualBalance,
      discrepancy: s.discrepancy,
      discrepancyPercentage: s.discrepancyPercentage,
      toleranceThreshold: s.toleranceThreshold,
      hasUnexplainedDiscrepancy: s.hasUnexplainedDiscrepancy,
      explanation: s.explanation,
      breakdown: s.breakdown as any,
    }));
  }

  /**
   * Stream reconciliation history as CSV rows for export.
   * Reuses the same history query as getReconciliationHistory so the
   * export reflects exactly what the JSON endpoint returns.
   */
  async *streamReconciliationCsv(
    from: Date,
    to: Date,
    asset?: string,
  ): AsyncGenerator<string> {
    const header = [
      "snapshotDate",
      "asset",
      "expectedBalance",
      "actualBalance",
      "discrepancy",
      "discrepancyPercentage",
      "toleranceThreshold",
      "hasUnexplainedDiscrepancy",
      "explanation",
      "fees",
      "slashes",
      "refunds",
    ];
    yield header.map((h) => this.escapeCsvField(h)).join(",") + "\n";

    const results = await this.getReconciliationHistory(from, to, asset);
    for (const r of results) {
      const row = [
        r.snapshotDate,
        r.asset,
        r.expectedBalance,
        r.actualBalance,
        r.discrepancy,
        String(r.discrepancyPercentage),
        r.toleranceThreshold,
        String(r.hasUnexplainedDiscrepancy),
        r.explanation,
        r.breakdown?.fees ?? "",
        r.breakdown?.slashes ?? "",
        r.breakdown?.refunds ?? "",
      ];
      yield row.map((v) => this.escapeCsvField(v)).join(",") + "\n";
    }
  }

  /**
   * Escape a value for inclusion in a CSV field (RFC 4180).
   */
  private escapeCsvField(value: string): string {
    if (value === undefined || value === null) {
      return "";
    }
    const str = String(value);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Get reconciliation summary for a date range
   */
  async getReconciliationSummary(
    from: Date,
    to: Date,
  ): Promise<ReconciliationSummary> {
    const snapshots = await this.prisma.treasurySnapshot.findMany({
      where: {
        snapshotDate: {
          gte: from,
          lte: to,
        },
      },
    });

    const totalSnapshots = snapshots.length;
    const unexplainedDiscrepancies = snapshots.filter(
      (s) => s.hasUnexplainedDiscrepancy,
    ).length;

    const assets = [...new Set(snapshots.map((s) => s.asset))];
    const byAsset = assets.map((asset) => {
      const assetSnapshots = snapshots.filter((s) => s.asset === asset);
      const totalDiscrepancy = assetSnapshots.reduce(
        (sum, s) => sum + BigInt(s.discrepancy),
        0n,
      );
      return {
        asset,
        snapshots: assetSnapshots.length,
        totalDiscrepancy: totalDiscrepancy.toString(),
        unexplainedDiscrepancies: assetSnapshots.filter(
          (s) => s.hasUnexplainedDiscrepancy,
        ).length,
      };
    });

    return {
      from: from.toISOString().split("T")[0],
      to: to.toISOString().split("T")[0],
      totalSnapshots,
      unexplainedDiscrepancies,
      byAsset,
    };
  }

  /**
   * Get detailed reconciliation for a specific date
   */
  async getReconciliationDetail(
    date: Date,
  ): Promise<ReconciliationDetailResponse> {
    const snapshotDate = date.toISOString().split("T")[0];
    const snapshots = await this.prisma.treasurySnapshot.findMany({
      where: {
        snapshotDate: new Date(snapshotDate),
      },
    });

    return {
      date: snapshotDate,
      results: snapshots.map((s) => ({
        snapshotDate: s.snapshotDate.toISOString().split("T")[0],
        asset: s.asset,
        expectedBalance: s.expectedBalance,
        actualBalance: s.actualBalance,
        discrepancy: s.discrepancy,
        discrepancyPercentage: s.discrepancyPercentage,
        toleranceThreshold: s.toleranceThreshold,
        hasUnexplainedDiscrepancy: s.hasUnexplainedDiscrepancy,
        explanation: s.explanation,
        breakdown: s.breakdown as any,
      })),
    };
  }

  /**
   * Daily reconciliation cron job
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async dailyReconciliation(): Promise<void> {
    this.logger.log("Starting daily treasury reconciliation");

    const assets = ["native", "USDC"];
    const today = new Date();

    for (const asset of assets) {
      try {
        await this.reconcileAsset(asset, today);
      } catch (error) {
        this.logger.error(`Reconciliation failed for ${asset}:`, error);
      }
    }

    this.logger.log("Daily treasury reconciliation complete");
  }
}
