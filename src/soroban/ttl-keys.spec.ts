import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  batchKeys,
  bondDataKey,
  contractCodeKey,
  contractInstanceKey,
  dedupeKeys,
  intentDataKey,
  prioritise,
  wasmHashFromInstance,
} from "./ttl-keys";

const SETTLEMENT = StrKey.encodeContract(Buffer.alloc(32, 1));
const REGISTRY = StrKey.encodeContract(Buffer.alloc(32, 2));
const HASH = "ab".repeat(32);

describe("ttl-keys (issue #395)", () => {
  describe("key derivation", () => {
    it("builds a persistent contract-instance key", () => {
      const k = contractInstanceKey("settlement", SETTLEMENT);
      const data = k.key.contractData();
      expect(k).toMatchObject({ kind: "instance", contract: "settlement", subject: SETTLEMENT });
      expect(Address.fromScAddress(data.contract()).toString()).toBe(SETTLEMENT);
      expect(data.key().switch()).toBe(xdr.ScValType.scvLedgerKeyContractInstance());
      expect(data.durability()).toBe(xdr.ContractDataDurability.persistent());
      expect(k.keyXdr).toBe(k.key.toXDR("base64"));
    });

    it("builds a contract-code key from a hex WASM hash and rejects malformed hashes", () => {
      const k = contractCodeKey("solver-registry", HASH.toUpperCase());
      expect(k.subject).toBe(HASH);
      expect(k.key.contractCode().hash().toString("hex")).toBe(HASH);
      expect(() => contractCodeKey("settlement", "abc")).toThrow(/invalid WASM hash/);
    });

    it("encodes intents as DataKey::<variant>(String id) in the settlement contract", () => {
      const k = intentDataKey(SETTLEMENT, "Intent", "550e8400-e29b-41d4-a716-446655440000");
      const vec = k.key.contractData().key().vec()!;
      expect(k).toMatchObject({ kind: "intent", contract: "settlement" });
      expect(vec[0].sym().toString()).toBe("Intent");
      expect(vec[1].str().toString()).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(k.key.contractData().durability()).toBe(xdr.ContractDataDurability.persistent());
    });

    it("encodes bonds as DataKey::<variant>(Address solver) in the registry", () => {
      const solver = Keypair.random().publicKey();
      const k = bondDataKey(REGISTRY, "SolverBond", solver);
      const data = k.key.contractData();
      const vec = data.key().vec()!;
      expect(Address.fromScAddress(data.contract()).toString()).toBe(REGISTRY);
      expect(vec[0].sym().toString()).toBe("SolverBond");
      expect(Address.fromScVal(vec[1]).toString()).toBe(solver);
    });

    it("gives different keys to different subjects and equal keys to equal subjects", () => {
      expect(intentDataKey(SETTLEMENT, "Intent", "a").keyXdr).not.toBe(intentDataKey(SETTLEMENT, "Intent", "b").keyXdr);
      expect(intentDataKey(SETTLEMENT, "Intent", "a").keyXdr).toBe(intentDataKey(SETTLEMENT, "Intent", "a").keyXdr);
    });
  });

  describe("wasmHashFromInstance", () => {
    function instanceEntry(executable: xdr.ContractExecutable): xdr.LedgerEntryData {
      return xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4)),
          contract: new Address(SETTLEMENT).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
        }),
      );
    }

    it("returns the WASM hash of a WASM contract", () => {
      const entry = instanceEntry(xdr.ContractExecutable.contractExecutableWasm(Buffer.from(HASH, "hex")));
      expect(wasmHashFromInstance(entry)).toBe(HASH);
    });

    it("returns undefined for a Stellar Asset Contract (no code entry)", () => {
      expect(wasmHashFromInstance(instanceEntry(xdr.ContractExecutable.contractExecutableStellarAsset()))).toBeUndefined();
    });
  });

  describe("batching", () => {
    it("splits keys into transactions of at most maxPerTx", () => {
      const keys = Array.from({ length: 45 }, (_, i) => i);
      const batches = batchKeys(keys, 20);
      expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
      expect(batches.flat()).toEqual(keys);
    });

    it("handles empty input and exact multiples", () => {
      expect(batchKeys([], 10)).toEqual([]);
      expect(batchKeys([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    });

    it("rejects a non-positive batch size", () => {
      expect(() => batchKeys([1], 0)).toThrow(/positive integer/);
      expect(() => batchKeys([1], 1.5)).toThrow(/positive integer/);
    });

    it("puts instance and code first, then the closest to archival", () => {
      const ordered = prioritise([
        { kind: "intent" as const, remainingLedgers: 5, id: "intent-5" },
        { kind: "code" as const, remainingLedgers: 900, id: "code" },
        { kind: "bond" as const, remainingLedgers: 1, id: "bond-1" },
        { kind: "instance" as const, remainingLedgers: 1000, id: "instance" },
      ]);
      expect(ordered.map((k) => k.id)).toEqual(["code", "instance", "bond-1", "intent-5"]);
    });

    it("deduplicates keys by XDR, keeping the first", () => {
      const a = contractInstanceKey("settlement", SETTLEMENT);
      const b = contractInstanceKey("solver-registry", SETTLEMENT); // misconfigured: same id
      expect(dedupeKeys([a, b])).toEqual([a]);
    });
  });
});
