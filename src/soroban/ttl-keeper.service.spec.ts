import { ConfigService } from "@nestjs/config";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { IntentsService } from "../intents/intents.service";
import { MetricsService } from "../metrics/metrics.service";
import { SolversService } from "../solvers/solvers.service";
import { SorobanService } from "./soroban.service";
import { ExtendFootprintTtlResult, StellarTxService, TtlExtensionOverBudgetError } from "./stellar-tx.service";
import { TtlKeeperService } from "./ttl-keeper.service";
import { contractCodeKey, contractInstanceKey, intentDataKey } from "./ttl-keys";

const SETTLEMENT = StrKey.encodeContract(Buffer.alloc(32, 1));
const REGISTRY = StrKey.encodeContract(Buffer.alloc(32, 2));
const SETTLEMENT_HASH = "11".repeat(32);
const REGISTRY_HASH = "22".repeat(32);
const LATEST = 1_000_000;

type Settings = AppConfig["ttlKeeper"];

const DEFAULTS: Settings = {
  enabled: true,
  intervalMs: 3_600_000,
  thresholdLedgers: 1_000,
  extendToLedgers: 10_000,
  dailyBudgetStroops: 1_000_000,
  maxKeysPerTx: 2,
  intentKeyVariant: "Intent",
  bondKeyVariant: "Bond",
};

function instanceVal(contractId: string, hash: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, "hex")),
          storage: null,
        }),
      ),
    }),
  );
}

interface Harness {
  keeper: TtlKeeperService;
  extend: jest.Mock;
  getLedgerEntries: jest.Mock;
  metrics: {
    setSorobanTtlRemaining: jest.Mock;
    incSorobanTtlExtensionTx: jest.Mock;
    incSorobanTtlKeysExtended: jest.Mock;
    setSorobanTtlBudgetSpent: jest.Mock;
    markSorobanTtlKeeperRun: jest.Mock;
  };
}

/**
 * `ttl` maps a key's base64 XDR to its liveUntilLedgerSeq; keys not in the map
 * are reported missing by the fake RPC.
 */
function build(opts: {
  settings?: Partial<Settings>;
  ttl: Record<string, number>;
  intents?: Record<string, string[]>;
  solvers?: Array<{ address: string; isActive: boolean }>;
  extendImpl?: (keys: xdr.LedgerKey[], extendTo: number, o: { maxFeeStroops?: number }) => Promise<ExtendFootprintTtlResult>;
}): Harness {
  const settings = { ...DEFAULTS, ...opts.settings };
  const config = {
    get: (path: string) =>
      ({
        ttlKeeper: settings,
        "stellar.settlementContractId": SETTLEMENT,
        "stellar.solverRegistryContractId": REGISTRY,
      })[path],
  } as unknown as ConfigService<AppConfig, true>;

  const instanceVals = new Map([
    [contractInstanceKey("settlement", SETTLEMENT).keyXdr, instanceVal(SETTLEMENT, SETTLEMENT_HASH)],
    [contractInstanceKey("solver-registry", REGISTRY).keyXdr, instanceVal(REGISTRY, REGISTRY_HASH)],
  ]);
  const getLedgerEntries = jest.fn(async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: LATEST,
    entries: keys
      .map((key) => ({ key, b64: key.toXDR("base64") }))
      .filter(({ b64 }) => opts.ttl[b64] !== undefined)
      .map(({ key, b64 }) => ({ key, val: instanceVals.get(b64), liveUntilLedgerSeq: opts.ttl[b64] })),
  }));
  const soroban = { getLedgerEntries, getLatestLedger: jest.fn() } as unknown as SorobanService;

  const extend = jest.fn(
    opts.extendImpl ??
      (async (keys: xdr.LedgerKey[]) => ({
        hash: `tx-${keys.length}`,
        status: "SUCCESS" as const,
        dryRun: false,
        feeStroops: 100,
      })),
  );
  const stellarTx = { extendFootprintTtl: extend } as unknown as StellarTxService;

  const intents = {
    getByState: jest.fn(async (state: string) =>
      (opts.intents?.[state] ?? []).map((intentId) => ({ intentId, state })),
    ),
  } as unknown as IntentsService;
  const solvers = { getAll: jest.fn(async () => opts.solvers ?? []) } as unknown as SolversService;
  const metrics = {
    setSorobanTtlRemaining: jest.fn(),
    incSorobanTtlExtensionTx: jest.fn(),
    incSorobanTtlKeysExtended: jest.fn(),
    setSorobanTtlBudgetSpent: jest.fn(),
    markSorobanTtlKeeperRun: jest.fn(),
  };

  const keeper = new TtlKeeperService(
    soroban,
    stellarTx,
    config,
    undefined,
    metrics as unknown as MetricsService,
    intents,
    solvers,
  );
  return { keeper, extend, getLedgerEntries, metrics };
}

const inst = (c: "settlement" | "solver-registry") =>
  contractInstanceKey(c, c === "settlement" ? SETTLEMENT : REGISTRY).keyXdr;
const code = (c: "settlement" | "solver-registry") =>
  contractCodeKey(c, c === "settlement" ? SETTLEMENT_HASH : REGISTRY_HASH).keyXdr;
const intentKey = (id: string) => intentDataKey(SETTLEMENT, "Intent", id).keyXdr;
const healthy = LATEST + 50_000;

describe("TtlKeeperService (issue #395)", () => {
  describe("key derivation", () => {
    it("tracks instances, their code, active intents and active solvers' bonds", async () => {
      const active = Keypair.random().publicKey();
      const inactive = Keypair.random().publicKey();
      const { keeper } = build({
        ttl: { [inst("settlement")]: healthy, [inst("solver-registry")]: healthy },
        intents: { open: ["i-open"], accepted: ["i-acc"], pending_filled: ["i-pend"], filled: ["i-done"] },
        solvers: [
          { address: active, isActive: true },
          { address: inactive, isActive: false },
          { address: "0xNotAStellarAddress", isActive: true },
        ],
      });

      const keys = await keeper.deriveKeys();

      expect(keys.map((k) => `${k.kind}:${k.subject}`).sort()).toEqual(
        [
          `instance:${SETTLEMENT}`,
          `instance:${REGISTRY}`,
          `code:${SETTLEMENT_HASH}`,
          `code:${REGISTRY_HASH}`,
          "intent:i-open",
          "intent:i-acc",
          "intent:i-pend",
          `bond:${active}`,
        ].sort(),
      );
    });

    it("skips code keys for an instance that cannot be read", async () => {
      const { keeper } = build({ ttl: { [inst("settlement")]: healthy } });
      const kinds = (await keeper.deriveKeys()).map((k) => `${k.kind}:${k.contract}`);
      expect(kinds).toEqual(["instance:settlement", "instance:solver-registry", "code:settlement"]);
    });
  });

  describe("report", () => {
    it("classifies entries and never submits", async () => {
      const { keeper, extend } = build({
        ttl: {
          [inst("settlement")]: LATEST + 500,
          [inst("solver-registry")]: healthy,
          [code("settlement")]: healthy,
          [code("solver-registry")]: healthy,
        },
        intents: { open: ["gone"] },
      });

      const report = await keeper.report();

      expect(extend).not.toHaveBeenCalled();
      expect(report.latestLedger).toBe(LATEST);
      const byKey = Object.fromEntries(report.entries.map((e) => [`${e.kind}:${e.contract}:${e.subject}`, e]));
      expect(byKey[`instance:settlement:${SETTLEMENT}`]).toMatchObject({
        status: "below_threshold",
        remainingLedgers: 500,
        remainingSecondsApprox: 2_500,
      });
      expect(byKey[`instance:solver-registry:${REGISTRY}`].status).toBe("ok");
      expect(byKey["intent:settlement:gone"]).toMatchObject({
        status: "missing",
        liveUntilLedgerSeq: null,
        remainingLedgers: null,
      });
    });

    it("publishes the minimum remaining TTL per kind, -1 when an entry is missing", async () => {
      const { keeper, metrics } = build({
        ttl: {
          [inst("settlement")]: LATEST + 700,
          [inst("solver-registry")]: LATEST + 300,
          [intentKey("a")]: LATEST + 900,
          [intentKey("b")]: LATEST + 200,
        },
        intents: { open: ["a", "b"] },
        solvers: [{ address: Keypair.random().publicKey(), isActive: true }],
      });

      await keeper.report();

      expect(metrics.setSorobanTtlRemaining).toHaveBeenCalledWith("instance", "settlement", 700);
      expect(metrics.setSorobanTtlRemaining).toHaveBeenCalledWith("instance", "solver-registry", 300);
      expect(metrics.setSorobanTtlRemaining).toHaveBeenCalledWith("intent", "settlement", 200);
      expect(metrics.setSorobanTtlRemaining).toHaveBeenCalledWith("bond", "solver-registry", -1);
    });
  });

  describe("run", () => {
    it("extends only live keys at or below the threshold, critical kinds first, in batches", async () => {
      const { keeper, extend } = build({
        settings: { maxKeysPerTx: 2 },
        ttl: {
          [inst("settlement")]: LATEST + 900, // below
          [inst("solver-registry")]: healthy,
          [code("settlement")]: LATEST + 1_000, // exactly at threshold → below
          [code("solver-registry")]: healthy,
          [intentKey("near")]: LATEST + 10, // below
          [intentKey("far")]: healthy,
        },
        intents: { open: ["near", "far", "missing"] },
      });

      const report = await keeper.run();

      expect(extend).toHaveBeenCalledTimes(2);
      const [first, second] = extend.mock.calls;
      expect(first[0].map((k: xdr.LedgerKey) => k.toXDR("base64")).sort()).toEqual(
        [inst("settlement"), code("settlement")].sort(),
      );
      expect(second[0].map((k: xdr.LedgerKey) => k.toXDR("base64"))).toEqual([intentKey("near")]);
      expect(first[1]).toBe(DEFAULTS.extendToLedgers);
      expect(report.extension).toMatchObject({ eligible: 3, extended: 3, budgetExhausted: false });
    });

    it("does nothing when every key is healthy", async () => {
      const { keeper, extend } = build({ ttl: { [inst("settlement")]: healthy, [inst("solver-registry")]: healthy } });
      const report = await keeper.run();
      expect(extend).not.toHaveBeenCalled();
      expect(report.extension).toEqual({ eligible: 0, extended: 0, transactions: [], budgetExhausted: false });
    });

    it("never extends missing (archived) entries", async () => {
      const { keeper, extend } = build({ ttl: {}, intents: { open: ["x"] } });
      await keeper.run();
      expect(extend).not.toHaveBeenCalled();
    });

    it("keeps going after a failed transaction", async () => {
      let calls = 0;
      const { keeper, metrics } = build({
        settings: { maxKeysPerTx: 1 },
        ttl: { [inst("settlement")]: LATEST + 1, [inst("solver-registry")]: LATEST + 2 },
        extendImpl: async () => {
          if (calls++ === 0) throw new Error("rpc down");
          return { hash: "ok", status: "SUCCESS", dryRun: false, feeStroops: 10 };
        },
      });

      const report = await keeper.run();

      expect(report.extension?.transactions.map((t) => t.status)).toEqual(["FAILED", "SUCCESS"]);
      expect(report.extension?.extended).toBe(1);
      expect(metrics.incSorobanTtlExtensionTx).toHaveBeenCalledWith("failed");
      expect(metrics.incSorobanTtlKeysExtended).toHaveBeenCalledWith("instance", 1);
    });

    it("does not spend budget on dry runs", async () => {
      const { keeper } = build({
        ttl: { [inst("settlement")]: LATEST + 1 },
        extendImpl: async () => ({ hash: null, status: "DRY_RUN", dryRun: true, feeStroops: 500 }),
      });
      const report = await keeper.run();
      expect(report.extension?.extended).toBe(0);
      expect(report.budget.spentStroops).toBe(0);
    });
  });

  describe("daily budget cap", () => {
    afterEach(() => jest.useRealTimers());

    const fourBelow = {
      [inst("settlement")]: LATEST + 1,
      [inst("solver-registry")]: LATEST + 2,
      [code("settlement")]: LATEST + 3,
      [code("solver-registry")]: LATEST + 4,
    };
    /** Each transaction costs 100 stroops; refuses when that exceeds the cap. */
    const pricedAt100 = async (_k: xdr.LedgerKey[], _e: number, o: { maxFeeStroops?: number }) =>
      (o.maxFeeStroops ?? Infinity) < 100
        ? { hash: null, status: "OVER_BUDGET" as const, dryRun: false, feeStroops: 100 }
        : { hash: "h", status: "SUCCESS" as const, dryRun: false, feeStroops: 100 };

    it("passes the remaining budget as the fee cap and stops when it runs out", async () => {
      const { keeper, extend, metrics } = build({
        settings: { maxKeysPerTx: 1, dailyBudgetStroops: 250 },
        ttl: fourBelow,
        extendImpl: pricedAt100,
      });

      const report = await keeper.run();

      expect(extend.mock.calls.map((c) => c[2].maxFeeStroops)).toEqual([250, 150, 50]);
      expect(report.extension).toMatchObject({ extended: 2, budgetExhausted: true });
      expect(report.budget).toMatchObject({ dailyStroops: 250, spentStroops: 200, remainingStroops: 50 });
      expect(metrics.incSorobanTtlExtensionTx).toHaveBeenCalledWith("over_budget");
      expect(metrics.setSorobanTtlBudgetSpent).toHaveBeenLastCalledWith(200);
    });

    it("submits nothing once the day's budget is spent, and resets at UTC midnight", async () => {
      jest.useFakeTimers({ now: new Date("2026-10-20T23:00:00Z"), doNotFake: ["nextTick", "setImmediate"] });
      const { keeper, extend } = build({
        settings: { maxKeysPerTx: 1, dailyBudgetStroops: 200 },
        ttl: fourBelow,
        extendImpl: pricedAt100,
      });

      await keeper.run();
      expect(extend).toHaveBeenCalledTimes(2);

      const again = await keeper.run();
      expect(extend).toHaveBeenCalledTimes(2);
      expect(again.extension?.budgetExhausted).toBe(true);

      jest.setSystemTime(new Date("2026-10-21T00:00:01Z"));
      const nextDay = await keeper.run();
      expect(extend).toHaveBeenCalledTimes(4);
      expect(nextDay.budget).toMatchObject({ day: "2026-10-21", spentStroops: 200 });
    });

    it("treats a prepared-fee overrun (thrown) as budget exhaustion", async () => {
      const { keeper, extend } = build({
        settings: { maxKeysPerTx: 1 },
        ttl: fourBelow,
        extendImpl: async () => {
          throw new TtlExtensionOverBudgetError(2_000_000, 1_000_000);
        },
      });

      const report = await keeper.run();

      expect(extend).toHaveBeenCalledTimes(1);
      expect(report.extension).toMatchObject({ budgetExhausted: true, extended: 0 });
      expect(report.extension?.transactions[0]).toMatchObject({ status: "OVER_BUDGET", feeStroops: 2_000_000 });
    });
  });

  it("shares one in-flight run between concurrent callers", async () => {
    const { keeper, getLedgerEntries } = build({ ttl: { [inst("settlement")]: healthy } });
    const [a, b] = await Promise.all([keeper.run(), keeper.run()]);
    expect(a).toBe(b);
    // instance read for code derivation + one scan chunk
    expect(getLedgerEntries).toHaveBeenCalledTimes(2);
    expect(keeper.getLastReport()).toBe(a);
  });
});
