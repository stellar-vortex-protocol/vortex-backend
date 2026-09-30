/**
 * One targeting rule. All specified conditions must match; the first matching
 * rule in a flag's list decides the value.
 */
export interface FlagRule {
  value: boolean;
  /** Match only this share (0-100) of targeting keys, bucketed deterministically. */
  percentage?: number;
  /** Match only these solver addresses. */
  solvers?: string[];
  /** Match only these chains. */
  chains?: string[];
}

/** Stored flag state (DB row minus bookkeeping). */
export interface FlagState {
  defaultValue: boolean;
  rules: FlagRule[];
}

export interface StoredFlag extends FlagState {
  key: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** Targeting attributes; `targetingKey` drives percentage bucketing (falls back to `solver`). */
export interface FlagContext {
  targetingKey?: string;
  solver?: string;
  chain?: string;
}
