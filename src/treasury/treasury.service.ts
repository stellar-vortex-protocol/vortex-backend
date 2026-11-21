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
      // Read the balance via a simulated `balance_of` call against the SAC contract.
      // A failed simulation must surface as an error (not a $0 balance) so that
      // reconcileAsset() does not manufacture a false discrepancy.
      const balance = await this.fetchSacBalance(asset);
      return {
        asset,
        balance,
        contract: asset,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch balance for ${asset}:`, error);
      throw error;
    }
  }

  /**
   * Read a SAC token balance for the treasury address via a simulated
   * `balance_of` contract call. Returns the balance normalized to base units.
   *
   * Throws if the simulation fails so callers can distinguish an RPC error
   * from a genuine zero balance.
   */
  private async fetchSacBalance(contractId: string): Promise<string> {
    const result = await this.soroban.simulateContractCall({
      contractId,
      method: "balance_of",
      args: [StellarSdk.Address.fromString(this.treasuryAddress).toScVal()],
    });

    if (!result || result.success === false) {
      const reason = result?.error ?? "unknown simulation error";
      throw new Error(
        `Soroban balance_of simulation failed for ${contractId}: ${reason}`,
      );
    }

    return this.parseSacBalance(result.result);
  }

  /**
   * Normalize a simulated SAC `balance_of` return value to a base-unit string.
   * SAC `balance_of` returns an i128 in the token's base units, so the value is
   * already in the same convention as the Horizon branches.
   */
  private parseSacBalance(value: unknown): string {
    if (value === null || value === undefined) {
      return "0";
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (typeof value === "number") {
      return BigInt(Math.trunc(value)).toString();
    }

    if (typeof value === "string") {
      return BigInt(value).toString();
    }

    // Handle ScVal-shaped results (e.g. { i128: { hi, lo } } or { value })
    const scVal = value as { value?: unknown; i128?: { hi: unknown; lo: unknown } };
    if (scVal.i128) {
      const hi = BigInt(scVal.i128.hi as string | number | bigint);
      const lo = BigInt(scVal.i128.lo as string | number | bigint);
      return ((hi << 64n) + (lo & 0xffffffffffffffffn)).toString();
    }
    if (scVal.value !== undefined) {
      return this.parseSacBalance(scVal.value);
    }

    throw new Error(`Unsupported SAC balance_of return value: ${String(value)}`);
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

/* … truncated 8196 chars — edit only what you need near the top … */
