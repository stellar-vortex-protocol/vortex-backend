import { SupportedChain } from "../intents/intents.types";

export interface SolverRecord {
  address: string;
  name: string;
  bondAmount: string;
  fillsCompleted: number;
  fillsFailed: number;
  totalVolume: string;
  avgFillTime: number; // seconds
  isActive: boolean;
  registeredAt: number;
  supportedChains: SupportedChain[];
  supportedTokens: string[];
}

/**
 * Life-cycle of a single slash penalty.
 *
 *   pending     — sweeper detected a missed deadline; on-chain submission
 *                 has been dispatched but not yet confirmed.
 *   confirmed   — solver_slashed event observed on-chain; bondAmount has
 *                 been reconciled to match the on-chain balance.
 *   failed      — on-chain submission failed (network error / contract
 *                 rejection); the fillsFailed increment is rolled back so
 *                 the solver's local record does not permanently reflect a
 *                 penalty that was never enforced on-chain.
 */
export type SolverPenaltyState = "pending" | "confirmed" | "failed";

/** A single pending-slash record keyed by intentId inside pendingPenalties. */
export interface SolverPendingPenalty {
  intentId: string;
  solverAddress: string;
  /** Unix timestamp (s) when the sweep detected the missed deadline. */
  detectedAt: number;
  state: SolverPenaltyState;
  /**
   * On-chain confirmed slash amount in bond units, populated once a
   * solver_slashed event is ingested and the penalty moves to "confirmed".
   */
  confirmedSlashAmount?: string;
}
