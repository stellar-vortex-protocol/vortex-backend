/**
 * Versioned protocol-fee rules (issue #438).
 *
 * Precedence is specific pair, then source chain, then the default rule.
 * Within a tier of specificity the highest `version` wins.
 *
 * Rounding: `ceil(amount * bps / 10_000)` charges at most one base unit more
 * than truncating division. Min/max caps are applied after that and can move
 * the fee by more than one unit; that is the cap, not the rounding. Integrator
 * share is floored, so any remainder stays with the treasury.
 */

export type FeeScope = "pair" | "chain" | "default";

export interface FeeTier {
  /** Inclusive trade size (base units) at which this bps applies. */
  minVolume: string;
  bps: number;
}

export interface FeeRule {
  id: string;
  version: number;
  scope: FeeScope;
  srcChain?: string;
  dstChain?: string;
  srcToken?: string;
  dstToken?: string;
  bps: number;
  /** Floor in base units. "0" disables the floor. */
  minFee: string;
  /** Ceiling in base units. "0" disables the ceiling. */
  maxFee: string;
  tiers: FeeTier[];
  /** Share of the protocol fee paid to an integrator, in bps of the fee. */
  integratorShareBps: number;
}

export interface ReferralCode {
  code: string;
  integratorId: string;
  shareBps: number;
}

export interface FeeInput {
  amount: string | bigint;
  srcChain: string;
  dstChain: string;
  srcToken?: string;
  dstToken?: string;
  /** Defaults to `amount` (per-trade tier). Pass cumulative volume to tier on history. */
  volume?: string | bigint;
  referralCode?: string;
}

export interface FeeQuote {
  amount: string;
  fee: string;
  treasuryFee: string;
  integratorFee: string;
  integratorId: string | null;
  referralCode: string | null;
  ruleId: string;
  ruleVersion: number;
  bps: number;
}

export const DEFAULT_FEE_RULE: FeeRule = {
  id: "default",
  version: 1,
  scope: "default",
  bps: 5,
  minFee: "0",
  maxFee: "0",
  tiers: [],
  integratorShareBps: 0,
};

const BPS_DENOMINATOR = 10_000n;

/** Ceil division. The result exceeds truncating division by at most 1. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function applyBpsCeil(amount: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error(`bps out of range: ${bps}`);
  if (amount < 0n) throw new Error("amount must be non-negative");
  return ceilDiv(amount * BigInt(bps), BPS_DENOMINATOR);
}

export function floorBps(amount: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error(`bps out of range: ${bps}`);
  if (amount < 0n) throw new Error("amount must be non-negative");
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

function parseUnits(value: string | bigint, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} must be non-negative`);
    return value;
  }
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a base-unit integer`);
  return BigInt(value);
}

function specificity(rule: FeeRule): number {
  if (rule.scope === "pair") return 3;
  if (rule.scope === "chain") return 2;
  return 1;
}

function matches(rule: FeeRule, input: FeeInput): boolean {
  if (rule.scope === "default") return true;
  if (rule.scope === "chain") {
    return rule.srcChain === input.srcChain && (!rule.dstChain || rule.dstChain === input.dstChain);
  }
  return (
    rule.srcChain === input.srcChain &&
    rule.dstChain === input.dstChain &&
    (!rule.srcToken || rule.srcToken === input.srcToken) &&
    (!rule.dstToken || rule.dstToken === input.dstToken)
  );
}

/** Highest-precedence matching rule. Pair beats chain beats default; then highest version. */
export function selectRule(rules: readonly FeeRule[], input: FeeInput): FeeRule {
  const matched = rules.filter((rule) => matches(rule, input));
  if (matched.length === 0) return DEFAULT_FEE_RULE;
  return matched.reduce((best, rule) => {
    const score = specificity(rule) - specificity(best);
    if (score !== 0) return score > 0 ? rule : best;
    return rule.version >= best.version ? rule : best;
  });
}

function tierBps(rule: FeeRule, volume: bigint): number {
  let bps = rule.bps;
  let floor = -1n;
  for (const tier of rule.tiers) {
    const min = parseUnits(tier.minVolume, "tier.minVolume");
    if (volume >= min && min >= floor) {
      floor = min;
      bps = tier.bps;
    }
  }
  return bps;
}

function clamp(fee: bigint, rule: FeeRule): bigint {
  const min = parseUnits(rule.minFee, "minFee");
  const max = parseUnits(rule.maxFee, "maxFee");
  if (max > 0n && min > max) throw new Error(`rule ${rule.id} has minFee above maxFee`);
  let next = fee;
  if (min > 0n && next < min) next = min;
  if (max > 0n && next > max) next = max;
  return next;
}

/**
 * Quote a protocol fee. Realized fees use this same function on the fill
 * amount, so a fill equal to the quoted amount reproduces the quote exactly.
 */
export function quoteFee(
  rules: readonly FeeRule[],
  referrals: readonly ReferralCode[],
  input: FeeInput,
): FeeQuote {
  const amount = parseUnits(input.amount, "amount");
  const volume = input.volume === undefined ? amount : parseUnits(input.volume, "volume");
  const rule = selectRule(rules.length > 0 ? rules : [DEFAULT_FEE_RULE], input);
  const bps = tierBps(rule, volume);
  const fee = clamp(applyBpsCeil(amount, bps), rule);

  const referral = input.referralCode
    ? referrals.find((item) => item.code === input.referralCode) ?? null
    : null;
  const shareBps = referral ? referral.shareBps : 0;
  const integratorFee = floorBps(fee, shareBps);
  const treasuryFee = fee - integratorFee;

  return {
    amount: amount.toString(),
    fee: fee.toString(),
    treasuryFee: treasuryFee.toString(),
    integratorFee: integratorFee.toString(),
    integratorId: referral?.integratorId ?? null,
    referralCode: referral?.code ?? null,
    ruleId: rule.id,
    ruleVersion: rule.version,
    bps,
  };
}

export function parseFeeRules(raw: string | undefined): FeeRule[] {
  if (!raw || raw.trim() === "" || raw.trim() === "[]") return [DEFAULT_FEE_RULE];
  const parsed = JSON.parse(raw) as FeeRule[];
  if (!Array.isArray(parsed) || parsed.length === 0) return [DEFAULT_FEE_RULE];
  return parsed;
}

export function parseReferrals(raw: string | undefined): ReferralCode[] {
  if (!raw || raw.trim() === "" || raw.trim() === "[]") return [];
  const parsed = JSON.parse(raw) as ReferralCode[];
  return Array.isArray(parsed) ? parsed : [];
}
