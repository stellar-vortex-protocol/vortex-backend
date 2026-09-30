/**
 * Synthetic canary tagging (issue #496).
 *
 * Canary traffic is identified through an address registry
 * (CANARY_ADDRESSES): an intent is a canary intent when its user or solver is
 * a registered canary address. Canary intents are excluded from public stats
 * and leaderboards and may only be accepted by a canary solver, so they never
 * touch real solvers' reputation.
 */
export function isCanaryIntent(
  intent: { user: string; solver?: string },
  canaryAddresses: ReadonlySet<string>,
): boolean {
  return canaryAddresses.has(intent.user) || (!!intent.solver && canaryAddresses.has(intent.solver));
}
