import { Injectable } from "@nestjs/common";
import { MemoryFeeLedger, type FeeLedgerEntry } from "./fee-ledger";
import { computeFeeQuote, type FeeQuote, type FeeQuoteInput } from "./fee-engine";

export interface IntegratorStatementLine {
  intentId: string;
  amount: string;
  createdAt: string;
}

export interface IntegratorStatement {
  integratorId: string;
  from: string;
  to: string;
  lines: IntegratorStatementLine[];
  total: string;
}

/** Fee quotes and the in-process double-entry ledger (issue #438). */
@Injectable()
export class FeesService {
  private readonly ledger = new MemoryFeeLedger();

  quote(input: FeeQuoteInput): FeeQuote {
    return computeFeeQuote(input);
  }

  postFill(input: FeeQuoteInput & { intentId: string }): FeeQuote {
    const quote = computeFeeQuote(input);
    this.ledger.postingsForFill({ intentId: input.intentId, quote });
    return quote;
  }

  entries(): FeeLedgerEntry[] {
    return this.ledger.all();
  }

  totals() {
    return this.ledger.totals();
  }

  /**
   * Payout statement for a single integrator over a date window (issue #623).
   * Sums `credit`/`integrator` entries for the given accountId, one line per
   * intentId, plus a total. Returns a well-formed empty statement when there
   * is no activity in range.
   */
  getIntegratorStatement(
    integratorId: string,
    from: Date,
    to: Date,
  ): IntegratorStatement {
    const fromMs = from.getTime();
    const toMs = to.getTime();

    const matching = this.ledger
      .all()
      .filter(
        (entry) =>
          entry.account === "integrator" &&
          entry.accountId === integratorId &&
          entry.direction === "credit" &&
          entry.createdAt.getTime() >= fromMs &&
          entry.createdAt.getTime() <= toMs,
      );

    const byIntent = new Map<string, IntegratorStatementLine>();
    for (const entry of matching) {
      const existing = byIntent.get(entry.intentId);
      if (existing) {
        existing.amount = addDecimal(existing.amount, entry.amount);
      } else {
        byIntent.set(entry.intentId, {
          intentId: entry.intentId,
          amount: entry.amount,
          createdAt: entry.createdAt.toISOString(),
        });
      }
    }

    const lines = Array.from(byIntent.values());
    const total = lines.reduce((sum, line) => addDecimal(sum, line.amount), "0");

    return {
      integratorId,
      from: from.toISOString(),
      to: to.toISOString(),
      lines,
      total,
    };
  }
}

/** Sum two non-negative decimal strings without floating-point drift. */
function addDecimal(a: string, b: string): string {
  const scale = Math.max(decimals(a), decimals(b));
  const ai = toScaledInt(a, scale);
  const bi = toScaledInt(b, scale);
  const sum = ai + bi;
  return fromScaledInt(sum, scale);
}

function decimals(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaledInt(value: string, scale: number): bigint {
  const [whole, frac = ""] = value.split(".");
  const padded = (frac + "0".repeat(scale)).slice(0, scale);
  return BigInt(`${whole || "0"}${padded}`);
}

function fromScaledInt(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}
