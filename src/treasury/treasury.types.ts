/**
 * Treasury Accounting Module Types
 * 
 * Types for treasury balance reconciliation, fee ledger tracking,
 * and discrepancy reporting.
 */

export interface AssetBalance {
  asset: string;
  balance: string; // bigint as string
  contract?: string;
}

export interface ExpectedBalance {
  asset: string;
  totalFees: string; // bigint as string
  totalSlashes: string; // bigint as string
  totalRefunds: string; // bigint as string
  netExpected: string; // bigint as string (fees + slashes - refunds)
}

export interface ReconciliationResult {
  snapshotDate: string;
  asset: string;
  expectedBalance: string;
  actualBalance: string;
  discrepancy: string;
  discrepancyPercentage: number;
  toleranceThreshold: string;
  hasUnexplainedDiscrepancy: boolean;
  explanation: string | null;
  breakdown: {
    fees: string;
    slashes: string;
    refunds: string;
    inFlightSettlements?: string;
  };
}

export interface ReconciliationSummary {
  date: string;
  assets: ReconciliationResult[];
  totalDiscrepancies: number;
  assetsWithUnexplainedDiscrepancies: number;
  lastReconciliationAt: string;
}

export interface ReconciliationDetailResponse extends ReconciliationResult {
  recentTransactions: Array<{
    type: "fee" | "slash" | "refund";
    amount: string;
    timestamp: string;
    reference: string;
  }>;
}

export interface TreasuryAlert {
  id: string;
  severity: "warning" | "critical";
  asset: string;
  discrepancy: string;
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

export interface FeeLedgerEntry {
  intentId: string;
  asset: string;
  amount: string;
  accrualAt: Date;
  txHash?: string;
}

export interface SlashLedgerEntry {
  solverAddress: string;
  asset: string;
  amount: string;
  slashedAt: Date;
  reason: string;
  txHash?: string;
}

export interface RefundLedgerEntry {
  intentId: string;
  userAddress: string;
  asset: string;
  amount: string;
  issuedAt: Date;
  reason: string;
  txHash?: string;
}

export interface BurnForecastDailyBucket {
  date: string; // ISO date (YYYY-MM-DD)
  fees: string; // bigint as string
  slashes: string; // bigint as string
  refunds: string; // bigint as string
  net: string; // bigint as string (fees + slashes - refunds)
}

export interface BurnForecast {
  asset: string;
  windowDays: number;
  /** Number of distinct days within the window that had ledger activity. */
  distinctDays: number;
  /** True when there is not enough data to project a meaningful trend. */
  insufficientData: boolean;
  /** Human-readable reason when insufficientData is true. */
  insufficientDataReason: string | null;
  /** Net inflow/outflow per day over the trailing window (bigint as string). */
  netPerDay: string;
  /** "growing" | "flat" | "draining" | "unknown" */
  trend: "growing" | "flat" | "draining" | "unknown";
  /** Current treasury balance for the asset (bigint as string). */
  currentBalance: string;
  /** Estimated days until balance reaches zero; null when not draining. */
  daysToZero: number | null;
  /** Per-day breakdown of ledger activity within the window. */
  dailyBuckets: BurnForecastDailyBucket[];
}
