/**
 * Streaming abuse detector — types and constants.
 *
 * Rules-based, no ML.  Every decision is recorded in Redis so the audit trail
 * is queryable and every action is reversible.
 */

// ── Score thresholds ──────────────────────────────────────────────────────────

/**
 * Cumulative abuse score bands and their graduated responses.
 *
 *  < CHALLENGE_THRESHOLD  → pass (normal path)
 *  < THROTTLE_THRESHOLD   → challenge (PoW token or higher-tier API key)
 *  < BLOCK_THRESHOLD      → throttle (5 req/min hard cap)
 *  ≥ BLOCK_THRESHOLD      → block  (403, logged, reversible)
 *
 * All thresholds are in "abuse points"; individual rules add their configured
 * weight.  Keeping them as named constants makes unit tests readable.
 */
export const CHALLENGE_THRESHOLD = 30;
export const THROTTLE_THRESHOLD = 60;
export const BLOCK_THRESHOLD = 90;

// ── Signals / rule IDs ────────────────────────────────────────────────────────

export type AbuseSignal =
  | "create_cancel_ratio"   // ≥ N cancels per M creates in the sliding window
  | "dust_intent"            // srcAmount below DUST_AMOUNT_USD
  | "burst_identical"        // K identical-parameter intents within T seconds
  | "new_address"            // Horizon account creation age < MIN_ACCOUNT_AGE_SECONDS
  | "ip_asn_cluster"         // same IP/ASN seen from ≥ N distinct user addresses
  | "solver_spam";           // solver creating/cancelling in a tight loop

// ── Actions ───────────────────────────────────────────────────────────────────

export type AbuseAction = "pass" | "challenge" | "throttle" | "block";

// ── Rule configuration ────────────────────────────────────────────────────────

export interface AbuseRuleConfig {
  /** Whether this rule is active. */
  enabled: boolean;
  /** Points contributed to the cumulative score when the rule fires. */
  weight: number;
  /** Sliding window in seconds for counters kept in Redis. */
  windowSeconds: number;
}

export type AbuseRulesConfig = {
  [K in AbuseSignal]: AbuseRuleConfig & Record<string, unknown>;
} & {
  create_cancel_ratio: AbuseRuleConfig & {
    /** Minimum cancel:create ratio (e.g. 0.8 = 80%) to trigger. */
    minCancelRatio: number;
    /** Minimum number of creates before the ratio is evaluated. */
    minCreates: number;
  };
  dust_intent: AbuseRuleConfig & {
    /** USD value below which an intent is "dust". */
    maxDustUsd: number;
  };
  burst_identical: AbuseRuleConfig & {
    /** Max identical-parameter intents before score is added. */
    maxCount: number;
  };
  new_address: AbuseRuleConfig & {
    /** Account must be older than this (seconds) to avoid the signal. */
    minAgeSeconds: number;
  };
  ip_asn_cluster: AbuseRuleConfig & {
    /** How many distinct addresses from the same IP trigger the signal. */
    minAddressesPerIp: number;
  };
  solver_spam: AbuseRuleConfig & {
    /** Max accept+cancel cycles per window before solver is scored. */
    maxCycles: number;
  };
};

// ── Default rule configuration ────────────────────────────────────────────────

export const DEFAULT_ABUSE_RULES: AbuseRulesConfig = {
  create_cancel_ratio: {
    enabled: true,
    weight: 40,
    windowSeconds: 300,       // 5-minute sliding window
    minCancelRatio: 0.8,      // 80 % of creates are cancelled
    minCreates: 5,            // ignore until at least 5 creates are seen
  },
  dust_intent: {
    enabled: true,
    weight: 20,
    windowSeconds: 60,
    maxDustUsd: 0.01,         // < $0.01 equivalent is dust
  },
  burst_identical: {
    enabled: true,
    weight: 35,
    windowSeconds: 30,
    maxCount: 3,              // 3 identical intents in 30 s
  },
  new_address: {
    enabled: true,
    weight: 15,
    windowSeconds: 0,         // single-check; no sliding window needed
    minAgeSeconds: 86_400,    // address must be > 1 day old
  },
  ip_asn_cluster: {
    enabled: true,
    weight: 50,
    windowSeconds: 600,       // 10-minute window
    minAddressesPerIp: 5,     // 5 different user addresses from the same IP
  },
  solver_spam: {
    enabled: true,
    weight: 45,
    windowSeconds: 120,       // 2-minute window
    maxCycles: 10,            // 10 accept→cancel cycles
  },
};

// ── Evaluation context ────────────────────────────────────────────────────────

/**
 * Everything the scorer needs to evaluate one incoming intent-create event.
 * The caller (guard) populates this from the request and the intent DTO.
 */
export interface AbuseContext {
  /** Stellar user address (lower-cased). */
  userAddress: string;
  /** Solver address (lower-cased); present on accept/fill/cancel calls. */
  solverAddress?: string;
  /** Client IP address (after X-Forwarded-For trust). */
  clientIp: string;
  /** Autonomous System Number inferred from the IP, if available. */
  asn?: string;
  /** Source amount in the intent's token, as a string bigint. */
  srcAmount: string;
  /** USD price of the source token; used to evaluate dust threshold. */
  srcTokenPriceUsd?: number;
  /** Number of decimals of the source token. */
  srcTokenDecimals?: number;
  /** Deterministic fingerprint of the intent's parameters (excluding deadline). */
  intentFingerprint: string;
  /** Unix timestamp (seconds) of the earliest account activity (from Horizon); undefined if not yet fetched. */
  accountAgeSeconds?: number;
  /** Operation being performed: intent creation, cancellation, solver accept. */
  operation: "create" | "cancel" | "accept" | "fill";
}

// ── Scoring result ─────────────────────────────────────────────────────────────

export interface SignalFiring {
  signal: AbuseSignal;
  weight: number;
  detail: string;
}

export interface AbuseScore {
  /** Sum of weights for all fired rules. */
  total: number;
  /** Graduated action decided by thresholds. */
  action: AbuseAction;
  /** Individual signals that contributed to the score. */
  signals: SignalFiring[];
  /** Actor keys that were evaluated (user address, ip, solver). */
  actors: string[];
  /** Whether the actor is on the API-key allowlist (score is still recorded but action is always "pass"). */
  allowlisted: boolean;
}

// ── Audit event ────────────────────────────────────────────────────────────────

export interface AbuseAuditEvent {
  timestamp: string;
  userAddress: string;
  clientIp: string;
  operation: AbuseContext["operation"];
  score: number;
  action: AbuseAction;
  signals: SignalFiring[];
  allowlisted: boolean;
}
