import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
  ReconciliationHistoryResponse,
  FeeLedgerEntry,
  SlashLedgerEntry,
  RefundLedgerEntry,
} from "./treasury.types";
import { AppConfig } from "../config/configuration";

/** Maximum number of days allowed in a reconciliation history range. */
export const MAX_RECONCILIATION_HISTORY_DAYS = 180;

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
   * Return the treasurySnapshot series for an asset across a bounded date range.
   * Rejects inverted ranges and ranges exceeding MAX_RECONCILIATION_HISTORY_DAYS.
   */
  async getReconciliationHistory(
    asset: string,
    from: string,
    to: string,
  ): Promise<ReconciliationHistoryResponse> {
    const fromDate = this.parseSnapshotDate(from, "from");
    const toDate = this.parseSnapshotDate(to, "to");

    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException("from must be on or before to");
    }

    const rangeDays =
      Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
    if (rangeDays > MAX_RECONCILIATION_HISTORY_DAYS) {
      throw new BadRequestException(
        `Date range must not exceed ${MAX_RECONCILIATION_HISTORY_DAYS} days`,
      );
    }

    const rows = await this.prisma.treasurySnapshot.findMany({
      where: {
        asset,
        snapshotDate: { gte: from, lte: to },
      },
      orderBy: { snapshotDate: "asc" },
    });

    return {
      asset,
      from,
      to,
      entries: rows.map((row) => ({
        snapshotDate: row.snapshotDate,
        asset: row.asset,
        expectedBalance: row.expectedBalance,
        actualBalance: row.actualBalance,
        discrepancy: row.discrepancy,
        discrepancyPercentage: Number(row.discrepancyPercentage),
        hasUnexplainedDiscrepancy: row.hasUnexplainedDiscrepancy,
      })),
    };
  }

  /**
   * Parse and validate a YYYY-MM-DD snapshot date string.
   */
  private parseSnapshotDate(value: string, field: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
    }
    return parsed;
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

    const direction = discrepancy > 0n ? "surplus" : "deficit";
    const absAmount = discrepancy < 0n ? -discrepancy : discrepancy;

    if (!hasUnexplainedDiscrepancy) {
      return `Minor ${direction} of ${absAmount} ${asset} within tolerance`;
    }

    return `Unexplained ${direction} of ${absAmount} ${asset} exceeds tolerance threshold`;
  }
}
