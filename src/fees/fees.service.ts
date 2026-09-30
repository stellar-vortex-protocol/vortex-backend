import { Injectable } from "@nestjs/common";
import {
  FeeInput,
  FeeQuote,
  parseFeeRules,
  parseReferrals,
  quoteFee,
} from "./fee-engine";
import { LedgerEntry, LedgerTotals, MemoryFeeLedger, postingsForFill } from "./fee-ledger";

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
