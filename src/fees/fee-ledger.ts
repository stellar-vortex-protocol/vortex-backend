import { FeeQuote } from "./fee-engine";

export type LedgerSide = "debit" | "credit";
export type LedgerAccount = "user" | "treasury" | "integrator";

/** One double-entry posting. Amounts are base-unit integers. */
export interface LedgerEntry {
  id: string;
  intentId: string;
  ruleId: string;
  ruleVersion: number;
  side: LedgerSide;
  account: LedgerAccount;
  accountId: string;
  amount: string;
  createdAt: number;
}

export class UnbalancedLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbalancedLedgerError";
  }
}

export function sumSide(entries: readonly LedgerEntry[], side: LedgerSide): bigint {
  return entries.reduce((sum, entry) => (entry.side === side ? sum + BigInt(entry.amount) : sum), 0n);
}

/** Throws unless Σ debits = Σ credits. */
export function assertBalanced(entries: readonly LedgerEntry[]): void {
  const debits = sumSide(entries, "debit");
  const credits = sumSide(entries, "credit");
  if (debits !== credits) {
    throw new UnbalancedLedgerError(`ledger out of balance: debits ${debits} credits ${credits}`);
  }
}

/** Postings for one fill. Debit the user, credit treasury and (optionally) the integrator. */
export function postingsForFill(quote: FeeQuote, intentId: string, userId: string, createdAt: number): LedgerEntry[] {
  const fee = BigInt(quote.fee);
  if (fee === 0n) return [];
  const entries: LedgerEntry[] = [
    {
      id: `${intentId}:debit:user`,
      intentId,
      ruleId: quote.ruleId,
      ruleVersion: quote.ruleVersion,
      side: "debit",
      account: "user",
      accountId: userId,
      amount: quote.fee,
      createdAt,
    },
    {
      id: `${intentId}:credit:treasury`,
      intentId,
      ruleId: quote.ruleId,
      ruleVersion: quote.ruleVersion,
      side: "credit",
      account: "treasury",
      accountId: "treasury",
      amount: quote.treasuryFee,
      createdAt,
    },
  ];
  if (BigInt(quote.integratorFee) > 0n && quote.integratorId) {
    entries.push({
      id: `${intentId}:credit:integrator`,
      intentId,
      ruleId: quote.ruleId,
      ruleVersion: quote.ruleVersion,
      side: "credit",
      account: "integrator",
      accountId: quote.integratorId,
      amount: quote.integratorFee,
      createdAt,
    });
  }
  assertBalanced(entries);
  return entries;
}

export interface LedgerTotals {
  entryCount: number;
  totalFees: string;
  treasuryFees: string;
  integratorFees: string;
  balanced: true;
}

export class MemoryFeeLedger {
  private readonly entries: LedgerEntry[] = [];

  append(batch: readonly LedgerEntry[]): void {
    assertBalanced(batch);
    assertBalanced([...this.entries, ...batch]);
    this.entries.push(...batch);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  totals(now = Math.floor(Date.now() / 1000), windowSec = 86_400): LedgerTotals & { last24hFees: string } {
    assertBalanced(this.entries);
    const treasury = this.entries
      .filter((entry) => entry.side === "credit" && entry.account === "treasury")
      .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    const integrator = this.entries
      .filter((entry) => entry.side === "credit" && entry.account === "integrator")
      .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    const last24h = this.entries
      .filter(
        (entry) =>
          entry.side === "debit" && entry.account === "user" && entry.createdAt >= now - windowSec,
      )
      .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    return {
      entryCount: this.entries.length,
      totalFees: (treasury + integrator).toString(),
      treasuryFees: treasury.toString(),
      integratorFees: integrator.toString(),
      last24hFees: last24h.toString(),
      balanced: true,
    };
  }
}
