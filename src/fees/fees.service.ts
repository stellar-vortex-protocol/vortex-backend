import { BadRequestException, Injectable } from "@nestjs/common";
import {
  FeeInput,
  FeeQuote,
  FeeRule,
  ReferralCode,
  parseFeeRules,
  parseReferrals,
  quoteFee,
} from "./fee-engine";
import { LedgerEntry, LedgerTotals, MemoryFeeLedger, postingsForFill } from "./fee-ledger";

/** Maximum number of sample inputs accepted by a single simulation request. */
export const MAX_SIMULATION_INPUTS = 100;

/** Per-rule validation failure surfaced by {@link FeesService.simulate}. */
export interface RuleValidationError {
  index: number;
  ruleId?: string;
  message: string;
}

export interface SimulationRequest {
  rules: FeeRule[];
  referrals?: ReferralCode[];
  inputs: FeeInput[];
}

export interface SimulationResult {
  quotes: FeeQuote[];
  errors: RuleValidationError[];
}

/**
 * Protocol fee quotes and the double-entry ledger (issue #438).
 * On-chain collection is unchanged; this records the off-chain fee only.
 */
@Injectable()
export class FeesService {
  private readonly rules = parseFeeRules(process.env.FEE_RULES_JSON);
  private readonly referrals = parseReferrals(process.env.FEE_REFERRALS_JSON);
  private readonly ledger = new MemoryFeeLedger();

  /** Quote a fee for `amount` base units. */
  quote(input: FeeInput): FeeQuote {
    return quoteFee(this.rules, this.referrals, input);
  }

  /**
   * Dry-run a candidate rule set against sample inputs (issue #624).
   * Calls the pure {@link quoteFee} directly; never touches the live config
   * or the ledger. Candidate rules are validated with the same invariants
   * `clamp()` enforces, and failures are reported per-rule.
   */
  simulate(request: SimulationRequest): SimulationResult {
    const inputs = request.inputs ?? [];
    if (inputs.length > MAX_SIMULATION_INPUTS) {
      throw new BadRequestException(
        `at most ${MAX_SIMULATION_INPUTS} sample inputs per request`,
      );
    }

    const errors = validateRules(request.rules ?? []);
    if (errors.length > 0) {
      return { quotes: [], errors };
    }

    const referrals = request.referrals ?? [];
    const quotes = inputs.map((input) => quoteFee(request.rules, referrals, input));
    return { quotes, errors: [] };
  }

  post(quote: FeeQuote, intentId: string, userId: string, at?: number): void {
    const batch = postingsForFill(quote, intentId, userId, at ?? Math.floor(Date.now() / 1000));
    if (batch.length > 0) this.ledger.append(batch);
  }

  /**
   * Record the realized fee for a fill. Uses {@link quote} on the fill amount,
   * so the posting matches a quote of the same amount, chains, and referral.
   * Returns the quote that was posted. A zero fee writes nothing.
   */
  recordFill(input: FeeInput & { intentId: string; userId: string; at?: number }): FeeQuote {
    const quote = this.quote(input);
    this.post(quote, input.intentId, input.userId, input.at);
    return quote;
  }

  entries(): readonly LedgerEntry[] {
    return this.ledger.all();
  }

  totals(): LedgerTotals & { last24hFees: string } {
    return this.ledger.totals();
  }
}

/**
 * Validate candidate rules against the invariants `clamp()` relies on.
 * Returns one entry per offending rule so callers can surface them
 * individually rather than as a single generic error.
 */
function validateRules(rules: FeeRule[]): RuleValidationError[] {
  const errors: RuleValidationError[] = [];
  rules.forEach((rule, index) => {
    const ruleId = (rule as { id?: string }).id;
    const push = (message: string) => errors.push({ index, ruleId, message });

    if (rule.minFee !== undefined && rule.maxFee !== undefined && rule.minFee > rule.maxFee) {
      push(`minFee (${rule.minFee}) must not exceed maxFee (${rule.maxFee})`);
    }
    if (rule.minFee !== undefined && rule.minFee < 0) {
      push(`minFee (${rule.minFee}) must be non-negative`);
    }
    if (rule.maxFee !== undefined && rule.maxFee < 0) {
      push(`maxFee (${rule.maxFee}) must be non-negative`);
    }
    if (rule.tiers) {
      rule.tiers.forEach((tier, tierIndex) => {
        if (tier.minAmount !== undefined && tier.maxAmount !== undefined && tier.minAmount > tier.maxAmount) {
          push(`tier ${tierIndex}: minAmount (${tier.minAmount}) must not exceed maxAmount (${tier.maxAmount})`);
        }
      });
    }
  });
  return errors;
}
