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

/** One line item in an integrator payout statement (one row per intentId). */
export interface IntegratorStatementLine {
  intentId: string;
  ruleId: string;
  ruleVersion: number;
  amount: string;
  createdAt: number;
}

/** Read-side payout statement for a single integrator over a date window. */
export interface IntegratorStatement {
  integratorId: string;
  from: number;
  to: number;
  lines: IntegratorStatementLine[];
  total: string;
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

  /**
   * Sum credit/integrator entries for `integratorId` within [from, to] (inclusive),
   * grouped into one line per intentId. Returns a well-formed empty statement when
   * there is no activity in range.
   */
  integratorStatement(integratorId: string, from: number, to: number): IntegratorStatement {
    const matching = this.entries.filter(
      (entry) =>
        entry.side === "credit" &&
        entry.account === "integrator" &&
        entry.accountId === integratorId &&
        entry.createdAt >= from &&
        entry.createdAt <= to,
    );

    const byIntent = new Map<string, IntegratorStatementLine>();
    for (const entry of matching) {
      const existing = byIntent.get(entry.intentId);
      if (existing) {
        existing.amount = (BigInt(existing.amount) + BigInt(entry.amount)).toString();
      } else {
        byIntent.set(entry.intentId, {
          intentId: entry.intentId,
          ruleId: entry.ruleId,
          ruleVersion: entry.ruleVersion,
          amount: entry.amount,
          createdAt: entry.createdAt,
        });
      }
    }

    const lines = [...byIntent.values()].sort((a, b) => a.createdAt - b.createdAt);
    const total = lines.reduce((sum, line) => sum + BigInt(line.amount), 0n);

    return {
      integratorId,
      from,
      to,
      lines,
      total: total.toString(),
    };
  }
}
