/**
 * Shared types for the slash-dispute (appeal) subsystem.
 *
 * A solver disputes a slash with evidence; reviewers adjudicate it. Once
 * decided (upheld/overturned) a dispute is immutable. See
 * docs/governance/dispute-reviewers.md for reviewer selection.
 */

export const DISPUTE_STATUSES = ["open", "under_review", "upheld", "overturned"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export type DisputeResolution = "upheld" | "overturned";

/** Evidence a solver submits to contest a slash. */
export interface DisputeEvidence {
  /** On-chain transaction hashes proving the fill actually happened. */
  txHashes: string[];
  /** Free-form logs / error excerpts (RPC lag, reorg, backend bug). */
  logs: string[];
  note?: string;
}

/** Result of the automated evidence check (fill-verifier). */
export interface EvidenceVerification {
  verified: boolean;
  reason: string;
}

/** A dispute record. Immutable once `decidedAt` is set. */
export interface Dispute {
  disputeId: string;
  /** The slash being contested. */
  slashId: string;
  /** Solver address that filed the dispute. */
  solver: string;
  /** Intent the slash was issued against. */
  intentId: string;
  reason: string;
  evidence: DisputeEvidence;
  status: DisputeStatus;
  /** Unix epoch seconds the dispute was filed. */
  submittedAt: number;
  /** Unix epoch seconds by which review must complete (SLA). */
  deadline: number;
  autoVerification: EvidenceVerification;
  decidedAt?: number;
  decidedBy?: string;
  decisionReason?: string;
}

/** A treasury refund request created when a dispute is overturned. */
export interface TreasuryRefundRequest {
  refundId: string;
  disputeId: string;
  solver: string;
  slashId: string;
  /** Slashed amount to refund (base-unit string), when known. */
  amount?: string;
  status: "pending" | "processed";
  createdAt: number;
}

/** Public, anonymised dispute statistics (no solver addresses). */
export interface DisputeStatistics {
  total: number;
  open: number;
  underReview: number;
  upheld: number;
  overturned: number;
  overturnRate: number;
  avgResolutionSeconds: number;
  withinSla: number;
}

/** How long after a slash a solver may file a dispute (seconds). */
export const DISPUTE_WINDOW_SECONDS = 7 * 86_400;

/** How long a reviewer has to resolve a dispute (seconds). */
export const DISPUTE_SLA_SECONDS = 7 * 86_400;
