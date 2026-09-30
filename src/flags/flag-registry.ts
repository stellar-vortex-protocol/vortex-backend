import { AppConfig } from "../config/configuration";
import { possibleValues } from "./flag-evaluator";
import { FlagState } from "./flag.types";

interface FlagSpec {
  description: string;
  /** Env-derived default used when the flag has no DB row (or the DB is unreachable). */
  envDefault: (config: Pick<AppConfig, "onchainIntentsEnabled" | "onchainDryRun">) => boolean;
  /** When true for a proposed state, the change needs a second admin's approval. */
  requiresTwoApprovals?: (proposed: FlagState, nodeEnv: string) => boolean;
}

/**
 * Flags that may be managed at runtime (issue #495). Only these keys are
 * accepted by the admin API.
 *
 * Store modes (INTENTS_PERSISTENCE / SOLVERS_PERSISTENCE) are deliberately not
 * runtime flags: the repository adapter is bound at DI time and switching it
 * live would split data between stores.
 */
export const FLAG_REGISTRY = {
  "onchain-intents-enabled": {
    description: "Register new intents with the settlement contract (ONCHAIN_INTENTS_ENABLED).",
    envDefault: (c) => c.onchainIntentsEnabled,
  },
  "onchain-dry-run": {
    description: "Simulate on-chain writes without broadcasting (ONCHAIN_DRY_RUN).",
    envDefault: (c) => c.onchainDryRun,
    // Any state that can turn dry-run off for some context goes live with real funds.
    requiresTwoApprovals: (proposed, nodeEnv) =>
      nodeEnv === "production" && possibleValues(proposed).has(false),
  },
} satisfies Record<string, FlagSpec>;

export type FlagKey = keyof typeof FLAG_REGISTRY;

export function isFlagKey(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, key);
}

/** Parses FLAG_OVERRIDES ("key=true,key2=false"), ignoring unknown keys. */
export function parseFlagOverrides(raw: string): Map<FlagKey, boolean> {
  const overrides = new Map<FlagKey, boolean>();
  for (const pair of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [key, value] = pair.split("=");
    if (isFlagKey(key) && (value === "true" || value === "false")) overrides.set(key, value === "true");
  }
  return overrides;
}
