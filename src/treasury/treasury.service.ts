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
  TreasuryRefundRequestInput,
  TreasuryRefundRequestRecord,
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
   * Create a durable refund request for an overturned dispute.
   *
   * Idempotent per disputeId: if a request already exists for the dispute
   * it is returned unchanged rather than creating a duplicate row.
   */
  async requestRefund(
    input: TreasuryRefundRequestInput,
  ): Promise<TreasuryRefundRequestRecord> {
    const existing = await this.prisma.treasuryRefundRequest.findUnique({
      where: { disputeId: input.disputeId },
    });

    if (existing) {
      this.logger.log(
        `Refund request already exists for dispute ${input.disputeId}; skipping duplicate`,
      );
      return existing as TreasuryRefundRequestRecord;
    }

    const created = await this.prisma.treasuryRefundRequest.create({
      data: {
        disputeId: input.disputeId,
        solverAddress: input.solverAddress,
        amount: input.amount,
        asset: input.asset ?? "native",
        status: "requested",
        requestedAt: new Date(),
      },
    });

    this.logger.log(
      `Created refund request for dispute ${input.disputeId}: ${input.amount} to solver ${input.solverAddress}`,
    );

    return created as TreasuryRefundRequestRecord;
  }

  /**
   * List refund requests, optionally filtered by status.
   */
  async listRefundRequests(
    status?: "requested" | "executed" | "rejected",
  ): Promise<TreasuryRefundRequestRecord[]> {
    const rows = await this.prisma.treasuryRefundRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { requestedAt: "desc" },
    });
    return rows as TreasuryRefundRequestRecord[];
  }

  /**
   * Mark a refund request as executed with the on-chain tx hash.
   */
  async markRefundExecuted(
    id: string,
    txHash: string,
    executedBy: string,
  ): Promise<TreasuryRefundRequestRecord> {
    const updated = await this.prisma.treasuryRefundRequest.update({
      where: { id },
      data: {
        status: "executed",
        executedAt: new Date(),
        executedBy,
        executionTxHash: txHash,
      },
    });

    this.logger.log(`Refund request ${id} marked executed (tx ${txHash})`);
    return updated as TreasuryRefundRequestRecord;
  }

  /**
   * Mark a refund request as rejected with a reason.
   */
  async markRefundRejected(
    id: string,
    reason: string,
    executedBy: string,
  ): Promise<TreasuryRefundRequestRecord> {
    const updated = await this.prisma.treasuryRefundRequest.update({
      where: { id },
      data: {
        status: "rejected",
        executedAt: new Date(),
        executedBy,
        rejectionReason: reason,
      },
    });

    this.logger.log(`Refund request ${id} rejected: ${reason}`);
    return updated as TreasuryRefundRequestRecord;
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

    this.logger.log(
      `Reconciliation for ${asset}: expected=${expected.netExpected}, actual=${actual.balance}, discrepancy=${discrepancy}`,
    );

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
      return "Balances match exactly.";
    }

    if (!hasUnexplainedDiscrepancy) {
      return `Discrepancy of ${discrepancy} ${asset} is within tolerance threshold.`;
    }

    if (discrepancy > 0n) {
      return `Unexplained surplus of ${discrepancy} ${asset}. Actual balance exceeds expected. Possible causes: unrecorded fees, double-counted refunds, or external deposits.`;
    }

    return `Unexplained deficit of ${-discrepancy} ${asset}. Expected balance exceeds actual. Possible causes: unrecorded refunds, missing slash records, or unauthorized withdrawals.`;
  }

  /**
   * Run daily reconciliation for all tracked assets
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runDailyReconciliation(): Promise<ReconciliationSummary> {
    const snapshotDate = new Date().toISOString().split("T")[0];
    const assets = ["native", "USDC"]; // Could be configurable

    this.logger.log(`Starting daily reconciliation for ${assets.length} assets`);

    const results: ReconciliationResult[] = [];

    for (const asset of assets) {
      try {
        const result = await this.reconcileAsset(asset);
        results.push(result);
      } catch (error) {
        this.logger.error(`Failed to reconcile ${asset}:`, error);
      }
    }

    const totalDiscrepancies = results.filter((r) => r.hasUnexplainedDiscrepancy).length;
    const hasUnexplainedDiscrepancies = totalDiscrepancies > 0;

    const summary: ReconciliationSummary = {
      snapshotDate,
      assets: results,
      totalDiscrepancies,
      hasUnexplainedDiscrepancies,
    };

    if (hasUnexplainedDiscrepancies) {
      this.logger.warn(
        `Reconciliation completed with ${totalDiscrepancies} unexplained discrepancies`,
      );
    } else {
      this.logger.log("Reconciliation completed successfully - all balances match");
    }

    return summary;
  }

  /**
   * Get reconciliation details for a specific date
   */
  async getReconciliationDetails(date: Date): Promise<ReconciliationDetailResponse> {
    const snapshotDate = date.toISOString().split("T")[0];
    const assets = ["native", "USDC"];

    const results: ReconciliationResult[] = [];

    for (const asset of assets) {
      try {
        const result = await this.reconcileAsset(asset, date);
        results.push(result);
      } catch (error) {
        this.logger.error(`Failed to reconcile ${asset} for ${snapshotDate}:`, error);
      }
    }

    const totalDiscrepancies = results.filter((r) => r.hasUnexplainedDiscrepancy).length;

    return {
      summary: {
        snapshotDate,
        assets: results,
        totalDiscrepancies,
        hasUnexplainedDiscrepancies: totalDiscrepancies > 0,
      },
      results,
    };
  }
}
