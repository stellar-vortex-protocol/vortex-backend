import { DEFAULT_FEE_RULE, FeeRule, applyBpsCeil, ceilDiv, floorBps, parseFeeRules, parseReferrals, quoteFee, selectRule } from "./fee-engine";
import { MemoryFeeLedger, UnbalancedLedgerError, assertBalanced, postingsForFill } from "./fee-ledger";
import { FeesModule } from "./fees.module";
import { FeesService } from "./fees.service";

const pair: FeeRule = {
  ...DEFAULT_FEE_RULE,
  id: "eth-xlm",
  version: 3,
  scope: "pair",
  srcChain: "ethereum",
  dstChain: "stellar",
  srcToken: "USDC",
  dstToken: "XLM",
  bps: 20,
  tiers: [
    { minVolume: "1000000", bps: 15 },
    { minVolume: "10000000", bps: 10 },
  ],
  minFee: "1",
  maxFee: "5000",
  integratorShareBps: 2000,
};

const chain: FeeRule = {
  ...DEFAULT_FEE_RULE,
  id: "ethereum",
  version: 2,
  scope: "chain",
  srcChain: "ethereum",
  bps: 8,
};

const input = {
  amount: "1000000",
  srcChain: "ethereum",
  dstChain: "stellar",
  srcToken: "USDC",
  dstToken: "XLM",
};

describe("fee engine", () => {
  const rules = [DEFAULT_FEE_RULE, chain, pair];

  it("ceilDiv is truncating division or one more", () => {
    expect(ceilDiv(0n, 10n)).toBe(0n);
    expect(ceilDiv(10n, 10n)).toBe(1n);
    expect(ceilDiv(11n, 10n)).toBe(2n);
    expect(() => ceilDiv(1n, 0n)).toThrow(/denominator/);
  });

  it("charges at most one base unit above truncating division", () => {
    for (let amount = 0n; amount < 50_000n; amount += 7n) {
      for (const bps of [0, 1, 5, 30, 100]) {
        const floored = (amount * BigInt(bps)) / 10_000n;
        const charged = applyBpsCeil(amount, bps);
        const advantage = charged - floored;
        expect(advantage === 0n || advantage === 1n).toBe(true);
      }
    }
  });

  it("rejects bps and amounts outside range", () => {
    expect(() => applyBpsCeil(1n, -1)).toThrow(/bps/);
    expect(() => applyBpsCeil(1n, 10_001)).toThrow(/bps/);
    expect(() => applyBpsCeil(-1n, 1)).toThrow(/amount/);
    expect(() => floorBps(1n, -1)).toThrow(/bps/);
  });

  it("prefers a specific pair over the chain and the default", () => {
    expect(selectRule(rules, input).id).toBe("eth-xlm");
    expect(selectRule(rules, { ...input, srcToken: "DAI" }).id).toBe("ethereum");
    expect(selectRule(rules, { ...input, srcChain: "base" }).id).toBe("default");
    expect(selectRule([], input).id).toBe("default");
  });

  it("breaks version ties toward the newer rule", () => {
    const older = { ...chain, id: "old", version: 1 };
    const newer = { ...chain, id: "new", version: 4 };
    expect(selectRule([older, newer], { ...input, srcToken: "DAI" }).id).toBe("new");
  });

  it("applies the highest matching volume tier, then min and max caps", () => {
    const small = quoteFee(rules, [], input);
    expect(small.bps).toBe(15);
    expect(small.fee).toBe("1500");

    const whale = quoteFee(rules, [], { ...input, amount: "100000000", volume: "100000000" });
    expect(whale.bps).toBe(10);
    expect(whale.fee).toBe("5000");

    const dust = quoteFee(rules, [], { ...input, amount: "1", volume: "1" });
    expect(dust.fee).toBe("1");
  });

  it("splits a referral in the treasury's favour and ignores unknown codes", () => {
    const referrals = [{ code: "ALICE", integratorId: "int-1", shareBps: 2500 }];
    const quoted = quoteFee([DEFAULT_FEE_RULE], referrals, { ...input, referralCode: "ALICE" });
    expect(quoted.fee).toBe("500");
    expect(quoted.integratorFee).toBe("125");
    expect(quoted.treasuryFee).toBe("375");
    expect(BigInt(quoted.integratorFee) + BigInt(quoted.treasuryFee)).toBe(BigInt(quoted.fee));

    const odd = quoteFee(
      [{ ...DEFAULT_FEE_RULE, bps: 1, integratorShareBps: 1 }],
      [{ code: "ODD", integratorId: "int-2", shareBps: 1 }],
      { amount: "1", srcChain: "base", dstChain: "stellar", referralCode: "ODD" },
    );
    expect(BigInt(odd.fee) - floorBps(BigInt(odd.amount), odd.bps) <= 1n).toBe(true);
    expect(odd.integratorId).toBe("int-2");

    const unknown = quoteFee([DEFAULT_FEE_RULE], referrals, { ...input, referralCode: "NOPE" });
    expect(unknown.integratorFee).toBe("0");
    expect(unknown.integratorId).toBeNull();
  });

  it("rejects a negative bigint amount", () => {
    expect(() => quoteFee([DEFAULT_FEE_RULE], [], { ...input, amount: -1n })).toThrow(/non-negative/);
    expect(quoteFee([DEFAULT_FEE_RULE], [], { ...input, amount: 1_000_000n }).fee).toBe("500");
    expect(() => floorBps(-1n, 1)).toThrow(/amount/);
  });

  it("rejects a non-integer amount and a rule whose min exceeds its max", () => {
    expect(() => quoteFee([DEFAULT_FEE_RULE], [], { ...input, amount: "1.5" })).toThrow(/base-unit/);
    expect(() =>
      quoteFee([{ ...DEFAULT_FEE_RULE, minFee: "5", maxFee: "1" }], [], { ...input, srcChain: "base" }),
    ).toThrow(/minFee/);
  });

  it("parses empty rule and referral payloads back to the built-in default", () => {
    expect(parseFeeRules(undefined)[0].id).toBe("default");
    expect(parseFeeRules("[]")[0].bps).toBe(5);
    expect(parseFeeRules(JSON.stringify([chain]))[0].id).toBe("ethereum");
    expect(parseReferrals("")).toEqual([]);
    expect(parseReferrals("null")).toEqual([]);
    expect(parseReferrals(JSON.stringify([{ code: "A", integratorId: "i", shareBps: 1 }]))).toHaveLength(1);
  });
});

describe("fee ledger", () => {
  it("posts a balanced fill and rejects a batch that does not balance", () => {
    const quote = quoteFee([DEFAULT_FEE_RULE], [{ code: "ALICE", integratorId: "int-1", shareBps: 2500 }], {
      ...input,
      referralCode: "ALICE",
    });
    const batch = postingsForFill(quote, "intent-1", "user-1", 1_700_000_000);
    expect(batch).toHaveLength(3);
    assertBalanced(batch);

    const ledger = new MemoryFeeLedger();
    ledger.append(batch);
    ledger.append(postingsForFill(quote, "intent-2", "user-1", 1_700_000_100));
    const totals = ledger.totals(1_700_000_100);
    expect(totals.balanced).toBe(true);
    expect(totals.totalFees).toBe((BigInt(quote.fee) * 2n).toString());
    expect(BigInt(totals.treasuryFees) + BigInt(totals.integratorFees)).toBe(BigInt(totals.totalFees));
    expect(totals.last24hFees).toBe(totals.totalFees);

    expect(() => ledger.append([{ ...batch[0], id: "bad", amount: "1" }])).toThrow(UnbalancedLedgerError);
    expect(() => assertBalanced([{ ...batch[0], amount: "3" }, { ...batch[1], amount: "1" }])).toThrow(
      /out of balance/,
    );
  });

  it("writes nothing for a zero fee", () => {
    const quote = quoteFee([DEFAULT_FEE_RULE], [], { ...input, amount: "0" });
    expect(postingsForFill(quote, "intent-0", "user", 1)).toEqual([]);
    expect(() =>
      postingsForFill({ ...quote, fee: "5", treasuryFee: "4", integratorFee: "1", integratorId: null }, "i", "u", 1),
    ).toThrow(UnbalancedLedgerError);
  });
});

describe("FeesService", () => {
  const previousRules = process.env.FEE_RULES_JSON;
  const previousReferrals = process.env.FEE_REFERRALS_JSON;

  afterEach(() => {
    process.env.FEE_RULES_JSON = previousRules;
    process.env.FEE_REFERRALS_JSON = previousReferrals;
  });

  it("records a fill that matches the quote and keeps the ledger balanced", () => {
    process.env.FEE_RULES_JSON = "[]";
    process.env.FEE_REFERRALS_JSON = JSON.stringify([{ code: "ALICE", integratorId: "int-1", shareBps: 1000 }]);
    const fees = new FeesService();
    const quoted = fees.quote({ ...input, referralCode: "ALICE" });
    const realized = fees.recordFill({ ...input, referralCode: "ALICE", intentId: "i1", userId: "u1", at: 10 });
    expect(realized).toEqual(quoted);
    expect(fees.totals().balanced).toBe(true);
    expect(fees.totals().totalFees).toBe(quoted.fee);
    expect(fees.entries()).toHaveLength(3);
    fees.post(fees.quote({ ...input, amount: "0" }), "zero", "u1");
    expect(fees.entries()).toHaveLength(3);
    expect(FeesModule).toBeDefined();
  });
});
