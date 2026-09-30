import {
  ALLOW_ALL,
  KillSwitchOperation,
  SwitchDecision,
  SwitchSnapshotEntry,
  SwitchTarget,
} from "./killswitch.types";

/**
 * Operations that are backed by an on-chain write, and are therefore also
 * gated by an `onchain`-scope switch. `create`/`accept` are database-only and
 * are deliberately *not* included: a chain-wide incident should be able to stop
 * settlement without also refusing to quote new intents.
 */
const ONCHAIN_GATED_OPERATIONS: ReadonlySet<KillSwitchOperation> = new Set<KillSwitchOperation>([
  "fill",
  "slash",
]);

/**
 * The switch operations to consider for a requested operation, most specific
 * first. An `onchain` switch applies as an additional, broader gate on the
 * operations it covers.
 */
export function candidateOperations(
  operation: KillSwitchOperation,
): KillSwitchOperation[] {
  if (ONCHAIN_GATED_OPERATIONS.has(operation)) {
    return [operation, "onchain"];
  }
  return [operation];
}

/**
 * Does a switch at `scope` govern this request?
 *
 * `null` in a switch's chain/token column is a wildcard, which lets an operator
 * pause e.g. "every operation on Stellar" without enumerating tokens. Scope
 * still bounds how specific a switch is allowed to be:
 *   - global    → always matches
 *   - chain     → same chain
 *   - token     → same chain, and same token or wildcard token
 *   - operation → same chain, same-or-wildcard token, and one of the candidate
 *                 operations (the requested one or the `onchain` umbrella)
 */
export function scopeMatches(
  entry: SwitchSnapshotEntry,
  scope: SwitchSnapshotEntry["scope"],
  target: SwitchTarget,
  candidates: readonly KillSwitchOperation[],
): boolean {
  switch (scope) {
    case "global":
      return true;

    case "chain":
      return entry.chain != null && entry.chain === target.chain;

    case "token":
      return (
        entry.chain != null &&
        entry.chain === target.chain &&
        (entry.token == null || entry.token === target.token)
      );

    case "operation":
      return (
        entry.chain != null &&
        entry.chain === target.chain &&
        (entry.token == null || entry.token === target.token) &&
        entry.operation != null &&
        candidates.includes(entry.operation)
      );
  }
}

/** Broadest → narrowest. Evaluation order is part of the contract. */
export const EVALUATION_ORDER: readonly SwitchSnapshotEntry["scope"][] = [
  "global",
  "chain",
  "token",
  "operation",
];

/**
 * Evaluate the switch hierarchy for a single write.
 *
 * Fail-closed: the write is blocked if **any** matching switch is active. A
 * narrower switch that is explicitly inactive does NOT re-open a scope a
 * broader switch is still holding closed — otherwise pausing all settlement
 * and then resuming "fill" for one token would silently re-enable the
 * dangerous path it was meant to contain. Resuming safely means clearing the
 * broad switch first.
 *
 * Pure: no I/O, no clock, no DI. Given the same snapshot the result is stable,
 * which is what makes this safe to run on the hot path of every write.
 */
export function evaluate(
  entries: readonly SwitchSnapshotEntry[],
  target: SwitchTarget & { operation: KillSwitchOperation },
): SwitchDecision {
  if (entries.length === 0) return ALLOW_ALL;

  const candidates = candidateOperations(target.operation);
  const matchedChain: SwitchSnapshotEntry[] = [];
  let governing: SwitchSnapshotEntry | null = null;

  for (const scope of EVALUATION_ORDER) {
    for (const entry of entries) {
      if (entry.scope !== scope) continue;
      if (!scopeMatches(entry, scope, target, candidates)) continue;

      matchedChain.push(entry);
      // Overwrite as we walk broad → narrow so the LAST (most specific) active
      // match wins: it is the narrowest rule actually blocking the write, which
      // is the most useful thing to put in the 503 body and the operator log.
      if (entry.active) governing = entry;
    }
  }

  if (matchedChain.length === 0) return ALLOW_ALL;

  return {
    // Any active match blocks — this is the fail-closed rule.
    paused: matchedChain.some((entry) => entry.active),
    matched: governing ?? matchedChain[matchedChain.length - 1] ?? null,
    matchedChain,
  };
}
