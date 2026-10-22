/**
 * Synthetic canary tagging (issue #496).
 *
 * Canary traffic is identified through a runtime-manageable address registry
 * (see `CanaryRegistryService`): an intent is a canary intent when its user or
 * solver is a registered canary address. Canary intents are excluded from
 * public stats and leaderboards and may only be accepted by a canary solver,
 * so they never touch real solvers' reputation.
 *
 * The registry is no longer a frozen config Set: callers pass the current
 * registry snapshot (or resolve it asynchronously) so that adding or rotating
 * a canary keypair takes effect without a process restart.
 */

/** Anything that can supply the current set of canary addresses. */
export type CanaryAddressSource =
  | ReadonlySet<string>
  | (() => ReadonlySet<string> | Promise<ReadonlySet<string>>);

async function resolveCanaryAddresses(source: CanaryAddressSource): Promise<ReadonlySet<string>> {
  if (typeof source === 'function') {
    return source();
  }
  return source;
}

/**
 * Returns true when the intent's user or solver is a registered canary
 * address. The exclusion logic (user or solver membership) is unchanged; only
 * the source of the address set is now pluggable.
 */
export async function isCanaryIntent(
  intent: { user: string; solver?: string },
  canaryAddresses: CanaryAddressSource,
): Promise<boolean> {
  const addresses = await resolveCanaryAddresses(canaryAddresses);
  return addresses.has(intent.user) || (!!intent.solver && addresses.has(intent.solver));
}

/**
 * Synchronous variant for callers that already hold a resolved snapshot
 * (e.g. `StatsService` after awaiting the registry). Keeps the original
 * membership check semantics.
 */
export function isCanaryIntentSync(
  intent: { user: string; solver?: string },
  canaryAddresses: ReadonlySet<string>,
): boolean {
  return canaryAddresses.has(intent.user) || (!!intent.solver && canaryAddresses.has(intent.solver));
}