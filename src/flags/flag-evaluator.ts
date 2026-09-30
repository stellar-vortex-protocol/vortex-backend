import { createHash } from "node:crypto";
import { FlagContext, FlagRule, FlagState } from "./flag.types";

export type FlagReason = "TARGETING_MATCH" | "SPLIT" | "DEFAULT";

export interface FlagEvaluation {
  value: boolean;
  reason: FlagReason;
  /** Index of the matching rule, when one matched. */
  ruleIndex?: number;
}

/** Stable 0-99 bucket for `key` + targeting key, so a target stays in or out of a rollout. */
export function bucketFor(flagKey: string, targetingKey: string): number {
  return createHash("sha256").update(`${flagKey}:${targetingKey}`).digest().readUInt32BE(0) % 100;
}

function matches(flagKey: string, rule: FlagRule, ctx: FlagContext): boolean {
  if (rule.solvers && !(ctx.solver && rule.solvers.includes(ctx.solver))) return false;
  if (rule.chains && !(ctx.chain && rule.chains.includes(ctx.chain))) return false;
  if (rule.percentage !== undefined) {
    const key = ctx.targetingKey ?? ctx.solver;
    // Percentage rollouts need a stable identity; without one the rule is skipped.
    if (!key || bucketFor(flagKey, key) >= rule.percentage) return false;
  }
  return true;
}

/** Pure evaluation of a stored flag against a context: first matching rule, else default. */
export function evaluateFlag(flagKey: string, state: FlagState, ctx: FlagContext): FlagEvaluation {
  const ruleIndex = state.rules.findIndex((rule) => matches(flagKey, rule, ctx));
  if (ruleIndex === -1) return { value: state.defaultValue, reason: "DEFAULT" };
  const rule = state.rules[ruleIndex];
  return { value: rule.value, reason: rule.percentage !== undefined ? "SPLIT" : "TARGETING_MATCH", ruleIndex };
}

/** Every value the flag can resolve to for some context. */
export function possibleValues(state: FlagState): Set<boolean> {
  return new Set([state.defaultValue, ...state.rules.map((r) => r.value)]);
}
