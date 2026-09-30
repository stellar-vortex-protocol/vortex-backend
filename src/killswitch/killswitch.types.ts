/**
 * Kill-switch domain types (issue #477).
 *
 * Kept free of Nest/Prisma imports so the pure evaluation logic in
 * `evaluate` can be unit-tested without a DI container or a database, and so
 * other modules can import the types without pulling in the persistence layer.
 */

/** Operations that a switch can gate. Mirrors `KillSwitchOperation` in Prisma. */
export const KILL_SWITCH_OPERATIONS = [
  "create",
  "accept",
  "fill",
  "slash",
  "onchain",
] as const;

export type KillSwitchOperation = (typeof KILL_SWITCH_OPERATIONS)[number];

/** Object form of {@link KILL_SWITCH_OPERATIONS}, for `@IsEnum()`. */
export const KILL_SWITCH_OPERATION_ENUM = {
  CREATE: "create",
  ACCEPT: "accept",
  FILL: "fill",
  SLASH: "slash",
  ONCHAIN: "onchain",
} as const;

/** Scope levels, ordered broadest → narrowest. Mirrors `KillSwitchScope`. */
export const KILL_SWITCH_SCOPES = ["global", "chain", "token", "operation"] as const;

export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

/** Object form of {@link KILL_SWITCH_SCOPES}, for `@IsEnum()`. */
export const KILL_SWITCH_SCOPE_ENUM = {
  GLOBAL: "global",
  CHAIN: "chain",
  TOKEN: "token",
  OPERATION: "operation",
} as const;

/** Machine-readable reason codes returned to clients in the 503 body. */
export const KILL_SWITCH_REASON_CODES = [
  "INCIDENT",
  "TOKEN_DEPEGGED",
  "SOLVER_INCIDENT",
  "CHAIN_DEGRADED",
  "RPC_DEGRADED",
  "REGULATORY",
  "MAINTENANCE",
] as const;

export type KillSwitchReasonCode = (typeof KILL_SWITCH_REASON_CODES)[number];

/** Object form of {@link KILL_SWITCH_REASON_CODES}, for `@IsEnum()`. */
export const KILL_SWITCH_REASON_CODE_ENUM = {
  INCIDENT: "INCIDENT",
  TOKEN_DEPEGGED: "TOKEN_DEPEGGED",
  SOLVER_INCIDENT: "SOLVER_INCIDENT",
  CHAIN_DEGRADED: "CHAIN_DEGRADED",
  RPC_DEGRADED: "RPC_DEGRADED",
  REGULATORY: "REGULATORY",
  MAINTENANCE: "MAINTENANCE",
} as const;

export function isKillSwitchOperation(value: unknown): value is KillSwitchOperation {
  return (
    typeof value === "string" &&
    (KILL_SWITCH_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isKillSwitchScope(value: unknown): value is KillSwitchScope {
  return (
    typeof value === "string" && (KILL_SWITCH_SCOPES as readonly string[]).includes(value)
  );
}

/** A fully-qualified switch address. `null` = not set at this level. */
export interface SwitchTarget {
  chain?: string | null;
  token?: string | null;
  operation?: KillSwitchOperation | null;
}

/** Normalised, immutable snapshot of every switch in the system. */
export interface SwitchSnapshotEntry {
  scope: KillSwitchScope;
  chain: string | null;
  token: string | null;
  operation: KillSwitchOperation | null;
  active: boolean;
  reasonCode: string;
  reason: string;
  activatedBy: string;
  /** Unix epoch ms — monotonic change key for polling invalidation. */
  updatedAt: number;
}

/** Result of evaluating the hierarchy for one request. */
export interface SwitchDecision {
  /** true = the write must be blocked. */
  paused: boolean;
  /**
   * The switch that decided the outcome. Populated for both outcomes when a
   * matching switch exists, so callers can log the governing rule even when the
   * answer is "allowed" (an explicit operation-level resume inside a paused
   * chain is worth surfacing).
   */
  matched: SwitchSnapshotEntry | null;
  /** Broadest → narrowest list of switches that matched, most specific last. */
  matchedChain: SwitchSnapshotEntry[];
}

/** An empty decision: nothing matched, so the write is allowed. */
export const ALLOW_ALL: SwitchDecision = Object.freeze({
  paused: false,
  matched: null,
  matchedChain: [],
});

/** The "onchain" umbrella covers every write that touches the chain. */
export const ONCHAIN_OPERATION: KillSwitchOperation = "onchain";

/**
 * Canonical, collision-free encoding of a switch address.
 *
 * Postgres will not let Prisma generate a `findUnique` over nullable columns, so
 * uniqueness is carried by this non-null surrogate. The `|` separator cannot
 * occur in a chain name, token address, or operation name, so the mapping is
 * injective — two different scopes can never share a key.
 */
export function scopeKey(input: {
  scope: KillSwitchScope;
  chain: string | null;
  token: string | null;
  operation: KillSwitchOperation | null;
}): string {
  return [
    input.scope,
    input.chain ?? "",
    input.token ?? "",
    input.operation ?? "",
  ].join("|");
}
