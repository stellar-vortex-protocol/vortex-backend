import type { IntentFill, IntentFillStatus } from "../intents.types";
import { allocation, computeFillProgress, planReservation, proRataMinDst } from "./partial-fill.math";

function tranche(reservedAmount: string, status: IntentFillStatus, dstAmount?: string): IntentFill {
  return {
    fillId: `f-${Math.random()}`,
    intentId: "i",
    solver: "S",
    reservedAmount,
    minDstAmount: "0",
    status,
    reservedAt: 0,
    deadline: 100,
    ...(dstAmount ? { dstAmount } : {}),
  };
}

describe("planReservation (issue #427)", () => {
  const base = { srcAmount: "1000", minFillAmount: "100" };

  it("allows a reservation within the remainder and ≥ minFillAmount", () => {
    expect(planReservation({ ...base, fills: [], amount: "400" })).toEqual({ ok: true, remainingAfter: 600n });
  });

  it("counts reserved and filled tranches but not slashed / released ones", () => {
    const fills = [tranche("300", "reserved"), tranche("200", "filled"), tranche("400", "slashed"), tranche("100", "released")];
    expect(allocation("1000", fills)).toEqual({ srcAmount: 1000n, reserved: 300n, filled: 200n, remaining: 500n });
    expect(planReservation({ ...base, fills, amount: "500" })).toMatchObject({ ok: true, remainingAfter: 0n });
  });

  it("rejects an overshoot of the remainder instead of clipping it", () => {
    expect(planReservation({ ...base, fills: [tranche("700", "reserved")], amount: "301" })).toEqual({
      ok: false,
      reason: "exceeds_remaining",
      remaining: 300n,
    });
  });

  it("rejects below minFillAmount…", () => {
    expect(planReservation({ ...base, fills: [], amount: "99" })).toMatchObject({ ok: false, reason: "below_min_fill" });
  });

  it("…except when it takes the whole remainder (dust clearing)", () => {
    const fills = [tranche("950", "filled")];
    expect(planReservation({ ...base, fills, amount: "50" })).toMatchObject({ ok: true, remainingAfter: 0n });
    expect(planReservation({ ...base, fills, amount: "49" })).toMatchObject({ ok: false, reason: "below_min_fill" });
  });

  it("rejects when nothing remains", () => {
    expect(planReservation({ ...base, fills: [tranche("1000", "filled")], amount: "1" })).toMatchObject({
      ok: false,
      reason: "nothing_remaining",
    });
  });

  it.each(["0", "-5", "1.5", "abc"])("rejects malformed amount %s", (amount) => {
    expect(planReservation({ ...base, fills: [], amount })).toMatchObject({ ok: false, reason: "invalid_amount" });
  });

  it("defaults minFillAmount to 1", () => {
    expect(planReservation({ srcAmount: "10", minFillAmount: undefined, fills: [], amount: "1" })).toMatchObject({ ok: true });
  });

  it("invariant: no sequence of accepted plans ever exceeds srcAmount (randomised)", () => {
    for (let run = 0; run < 200; run++) {
      const src = BigInt(1 + Math.floor(Math.random() * 10_000));
      const fills: IntentFill[] = [];
      for (let step = 0; step < 50; step++) {
        const amount = String(1 + Math.floor(Math.random() * Number(src)));
        const plan = planReservation({ srcAmount: src.toString(), minFillAmount: "7", fills, amount });
        if (plan.ok) fills.push(tranche(amount, Math.random() < 0.3 ? "slashed" : "filled"));
        const { filled, reserved, remaining } = allocation(src.toString(), fills);
        expect(filled + reserved + remaining).toBe(src);
        expect(remaining >= 0n).toBe(true);
      }
    }
  });
});

describe("proRataMinDst", () => {
  it("is the exact share when it divides evenly", () => {
    expect(proRataMinDst("900", "250", "1000")).toBe("225");
  });

  it("rounds up, so the tranche minimums never sum below minDstAmount", () => {
    // 1000 split into three tranches with minDst 1000 → 334 + 334 + 334 ≥ 1000.
    const parts = ["333", "333", "334"].map((p) => BigInt(proRataMinDst("1000", p, "1000")));
    expect(parts.reduce((a, b) => a + b, 0n) >= 1000n).toBe(true);
    expect(proRataMinDst("10", "1", "3")).toBe("4");
  });

  it("handles amounts beyond Number precision", () => {
    expect(proRataMinDst("99999999999999999999", "1", "3")).toBe("33333333333333333333");
  });
});

describe("computeFillProgress", () => {
  it("reports none / partially_filled / filled", () => {
    expect(computeFillProgress({ srcAmount: "100", state: "open" }, []).status).toBe("none");
    expect(computeFillProgress({ srcAmount: "100", state: "open" }, [tranche("40", "filled", "39")])).toMatchObject({
      status: "partially_filled",
      filledAmount: "40",
      remainingAmount: "60",
      dstFilledAmount: "39",
      fillCount: 1,
    });
    expect(computeFillProgress({ srcAmount: "100", state: "filled" }, [tranche("100", "filled", "99")]).status).toBe("filled");
  });

  it("flags a cancelled remainder on a settled, partially filled intent", () => {
    const progress = computeFillProgress({ srcAmount: "100", state: "filled" }, [tranche("40", "filled", "39")]);
    expect(progress.remainderCancelled).toBe(true);
    expect(progress.status).toBe("partially_filled");
  });
});
