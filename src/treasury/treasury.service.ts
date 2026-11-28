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
  BurnForecast,
  BurnForecastDay,
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
   * Project net treasury growth/depletion per day over a trailing window and
   * estimate days-of-runway at the current burn rate.
   *
   * Uses the same fee/slash/refund ledger tables as calculateExpectedBalance(),
   * bucketed by day. Linear trend extrapolation only.
   */
  async getBurnForecast(asset: string, windowDays = 30): Promise<BurnForecast> {
    const window = Math.max(1, Math.floor(windowDays));
    const now = new Date();
    const since = new Date(now.getTime() - window * 24 * 60 * 60 * 1000);

    const [fees, slashes, refunds, expected] = await Promise.all([
      this.prisma.feeLedger.findMany({
        where: { asset, accrualAt: { gte: since, lte: now } },
      }),
      this.prisma.slashLedger.findMany({
        where: { asset, slashedAt: { gte: since, lte: now } },
      }),
      this.prisma.refundLedger.findMany({
        where: { asset, issuedAt: { gte: since, lte: now } },
      }),
      this.calculateExpectedBalance(asset, now),
    ]);

    const buckets = new Map<string, { fees: bigint; slashes: bigint; refunds: bigint }>();
    const bucketFor = (date: Date) => {
      const key = date.toISOString().slice(0, 10);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { fees: 0n, slashes: 0n, refunds: 0n };
        buckets.set(key, bucket);
      }
      return bucket;
    };

    for (const f of fees) {
      bucketFor(f.accrualAt).fees += BigInt(f.amount);
    }
    for (const s of slashes) {
      bucketFor(s.slashedAt).slashes += BigInt(s.amount);
    }
    for (const r of refunds) {
      bucketFor(r.issuedAt).refunds += BigInt(r.amount);
    }

    const daily: BurnForecastDay[] = Array.from(buckets.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, b]) => ({
        date,
        fees: b.fees.toString(),
        slashes: b.slashes.toString(),
        refunds: b.refunds.toString(),
        net: (b.fees + b.slashes - b.refunds).toString(),
      }));

    const activeDays = daily.length;
    const netOverWindow = daily.reduce((sum, d) => sum + BigInt(d.net), 0n);
    const currentBalance = BigInt(expected.netExpected);

    if (activeDays < 2) {
      return {
        asset,
        windowDays: window,
        activeDays,
        insufficientData: true,
        reason: "Fewer than 2 distinct days of ledger activity in the window",
        netOverWindow: netOverWindow.toString(),
        netPerDay: "0",
        currentBalance: currentBalance.toString(),
        daysToZero: null,
        daily,
      };
    }

    // Average net movement per day across the window (integer base units).
    const netPerDay = netOverWindow / BigInt(window);

    let daysToZero: number | null = null;
    if (netPerDay < 0n && currentBalance > 0n) {
      const burnPerDay = -netPerDay;
      // Round up so we never under-report runway.
      const days = (currentBalance + burnPerDay - 1n) / burnPerDay;
      daysToZero = Number(days);
    }

    return {
      asset,
      windowDays: window,
      activeDays,
      insufficientData: false,
      netOverWindow: netOverWindow.toString(),
      netPerDay: netPerDay.toString(),
      currentBalance: currentBalance.toString(),
      daysToZero,
      daily,
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
   * Parse a Horizon balance string into base units
   */
  private parseBalance(balance: string): string {
    const [whole, fraction = ""] = balance.split(".");
    const paddedFraction = fraction.padEnd(7, "0").slice(0, 7);
    return (BigInt(whole) * 10000000n + BigInt(paddedFraction)).toString();
  }

  /**
   * Reconcile a single asset
   */
  async reconcileAsset(asset: string): Promise<ReconciliationResult> {
    const expected = await this.calculateExpectedBalance(asset);
    const actual = await this.fetchActualBalance(asset);

    const expectedBalance = BigInt(expected.netExpected);
    const actualBalance = BigInt(actual.balance);
    const discrepancy = actualBalance - expectedBalance;

    const tolerance = this.toleranceThresholds.get(asset) ?? 0n;
    const withinTolerance = discrepancy <= tolerance && discrepancy >= -tolerance;

    return {
      asset,
      expectedBalance: expectedBalance.toString(),
      actualBalance: actualBalance.toString(),
      discrepancy: discrepancy.toString(),
      withinTolerance,
      checkedAt: new Date(),
    };
  }

  /**
   * Get reconciliation summary for all assets
   */
  async getReconciliationSummary(): Promise<ReconciliationSummary> {
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

    return {
      checkedAt: new Date(),
      assets: results,
      allWithinTolerance: results.every((r) => r.withinTolerance),
    };
  }

  /**
   * Get reconciliation detail for all assets
   */
  async getReconciliationDetail(): Promise<ReconciliationDetailResponse> {
    const assets = ["native", "USDC"];
    const expected: ExpectedBalance[] = [];

    for (const asset of assets) {
      try {
        const balance = await this.calculateExpectedBalance(asset);
        expected.push(balance);
      } catch (error) {
        this.logger.error(`Failed to calculate expected balance for ${asset}:`, error);
      }
    }

    const summary = await this.getReconciliationSummary();

    return {
      summary,
      expected,
    };
  }

  /**
   * Daily reconciliation cron job
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async dailyReconciliation(): Promise<void> {
    this.logger.log("Starting daily treasury reconciliation");

    try {
      const summary = await this.getReconciliationSummary();

      if (!summary.allWithinTolerance) {
        const discrepancies = summary.assets.filter((a) => !a.withinTolerance);
        this.logger.warn(
          `Treasury reconciliation found ${discrepancies.length} discrepancies`,
          discrepancies,
        );
      } else {
        this.logger.log("Treasury reconciliation passed for all assets");
      }
    } catch (error) {
      this.logger.error("Daily reconciliation failed:", error);
    }
  }
}
