import { SupportedChain } from "../intents/intents.types";

/** Maximum number of delegated operational signers allowed per solver (issue #639). */
export const MAX_DELEGATED_SIGNERS = 5;

/**
 * Maximum length of a scheduled solver pause, in seconds (issue #645).
 *
 * A `pause` call whose `until` is further out than this is rejected so a
 * solver cannot effectively deactivate itself indefinitely without the
 * manual `deactivate` path.
 */
export const MAX_PAUSE_DURATION_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Self-reported liquidity depth for a single (chain, token) pair (issue #640).
 *
 * `availableAmount` is a decimal string in the token's base units. It is
 * advisory only: the API uses it to hide intents larger than the solver has
 * advertised it can cover. It is never decremented on fill and never enforced
 * on-chain.
 */
export interface SolverInventoryEntry {
  token: string;
  chain: SupportedChain;
  availableAmount: string;
}

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
  /** Unix epoch seconds of the solver's most recent activity (registration, fill, or status change). */
  lastActiveAt: number;
  supportedChains: SupportedChain[];
  supportedTokens: string[];
  /**
   * Optional per-token liquidity/inventory depth declarations (issue #640).
   *
   * Opt-in: when no entry exists for a (chain, token) pair, intents for that
   * pair are unaffected. When an entry exists, intents whose source amount
   * exceeds `availableAmount` are filtered out of getEligibleIntents.
   */
  inventory?: SolverInventoryEntry[];
  /**
   * Secondary operational signing keys (issue #639).
   *
   * Each entry is a Stellar address that may sign day-to-day operations
   * (accept / fill / update) on behalf of the primary `address`. The bond,
   * reputation, and address of record always remain with the primary
   * `address`; delegates can never deregister or withdraw the bond.
   *
   * Capped at MAX_DELEGATED_SIGNERS. Absent/empty means no delegation.
   */
  delegatedSigners?: string[];
  /**
   * Address of the solver that referred this solver at registration time
   * (issue #641). Set once when the record is created and never mutated
   * afterward, so past referral attribution survives the referrer later
   * deregistering. Absent when the solver was not referred.
   */
  referredBy?: string;
  /**
   * Data source for this record (issue #399).
   * "api"   — created / updated via REST POST /solvers.
   * "chain" — projected from solver-registry contract events.
   */
  source?: "api" | "chain";
  /**
   * Ledger sequence of the most recent on-chain event applied to this row.
   * Null when source="api" (no on-chain event has been observed yet).
   * Used to resolve out-of-order events: events with a lower ledger than
   * this value are ignored during replay.
   */
  chainUpdatedLedger?: number | null;
  /**
   * Public-profile metadata (issue #643).
   *
   * `avatarUrl` and `websiteUrl` are always `https://` links to externally
   * hosted content (the API never hosts uploads). `description` is bounded
   * plain text with any HTML stripped. All three are solver-editable via
   * UpdateSolverDto.
   */
  avatarUrl?: string;
  description?: string;
  websiteUrl?: string;
  /**
   * Operator-only verification badge (issue #643).
   *
   * Settable exclusively through the admin-gated PATCH endpoint; a solver
   * can never self-certify. Absent/false means unverified.
   */
  verified?: boolean;
  /**
   * Optional minimum intent size in USD (issue #644).
   *
   * Opt-in: when set, getEligibleIntents excludes intents whose USD-estimated
   * source amount is below this value, so solvers are not shown dust-sized
   * intents that are unprofitable to fill given fixed costs. Absent means no
   * minimum is applied (default behavior unchanged). If the pricing
   * aggregator cannot price an intent's source token, the intent is included
   * (fail open), consistent with ORACLE_FAIL_OPEN_MAX_USD.
   */
  minIntentSizeUsd?: number;
  /**
   * Scheduled self-expiring pause (issue #645).
   *
   * Unix epoch seconds at which a scheduled pause lifts. Set by the signed
   * `pause` endpoint together with `isActive=false`; the background sweep
   * flips `isActive` back to true and clears this field once the timestamp
   * has passed. Absent means the solver is not on a scheduled pause — a
   * manual `deactivate` leaves this unset and is never auto-reactivated.
   */
  pausedUntil?: number;
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
