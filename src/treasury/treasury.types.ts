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
