import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/**
 * Ledger-key derivation and batching for the contract-state TTL keeper
 * (issue #395). Pure functions — no RPC, no config — so they can be tested
 * without a network.
 *
 * Tracked entries, all `persistent` and all owned by the protocol:
 *
 * | kind       | contract        | key                                         |
 * |------------|-----------------|---------------------------------------------|
 * | `instance` | each configured | `ScVal::LedgerKeyContractInstance`          |
 * | `code`     | each configured | `LedgerKey::ContractCode(wasm_hash)`        |
 * | `intent`   | settlement      | `DataKey::<intentVariant>(String intent_id)`|
 * | `bond`     | solver-registry | `DataKey::<bondVariant>(Address solver)`    |
 *
 * `DataKey` variants follow the soroban-sdk `#[contracttype]` enum encoding:
 * `Vec[Symbol(variant), arg]`. The variant names are configurable
 * (`TTL_KEEPER_INTENT_KEY_VARIANT` / `TTL_KEEPER_BOND_KEY_VARIANT`) because the
 * contract source lives outside this repository.
 */

/** Which protocol-owned entry a key refers to. */
export type TtlKeyKind = "instance" | "code" | "intent" | "bond";

/** Logical contract the entry belongs to. */
export type TtlContract = "settlement" | "solver-registry";

/** A ledger key the keeper watches, with enough context to report on it. */
export interface TrackedLedgerKey {
  kind: TtlKeyKind;
  contract: TtlContract;
  /** Contract ID, WASM hash (hex), intent ID or solver address. */
  subject: string;
  key: xdr.LedgerKey;
  /** Base64 XDR of `key`; the identity used to match RPC results back. */
  keyXdr: string;
}

/** Instance and code entries are never allowed to archive; they go first. */
export const CRITICAL_KINDS: readonly TtlKeyKind[] = ["instance", "code"];

function tracked(kind: TtlKeyKind, contract: TtlContract, subject: string, key: xdr.LedgerKey): TrackedLedgerKey {
  return { kind, contract, subject, key, keyXdr: key.toXDR("base64") };
}

function persistentData(contractId: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Ledger key of a contract's instance entry. */
export function contractInstanceKey(contract: TtlContract, contractId: string): TrackedLedgerKey {
  return tracked("instance", contract, contractId, persistentData(contractId, xdr.ScVal.scvLedgerKeyContractInstance()));
}

/** Ledger key of the WASM code entry with the given (hex) hash. */
export function contractCodeKey(contract: TtlContract, wasmHashHex: string): TrackedLedgerKey {
  if (!/^[0-9a-f]{64}$/i.test(wasmHashHex)) throw new Error(`invalid WASM hash: ${wasmHashHex}`);
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, "hex") }),
  );
  return tracked("code", contract, wasmHashHex.toLowerCase(), key);
}

/** `DataKey::<variant>(String intent_id)` in the settlement contract. */
export function intentDataKey(settlementId: string, variant: string, intentId: string): TrackedLedgerKey {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), nativeToScVal(intentId, { type: "string" })]);
  return tracked("intent", "settlement", intentId, persistentData(settlementId, key));
}

/** `DataKey::<variant>(Address solver)` in the solver-registry contract. */
export function bondDataKey(registryId: string, variant: string, solver: string): TrackedLedgerKey {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), new Address(solver).toScVal()]);
  return tracked("bond", "solver-registry", solver, persistentData(registryId, key));
}

/** Read the WASM hash (hex) out of a contract-instance ledger entry, if it has one. */
export function wasmHashFromInstance(entry: xdr.LedgerEntryData): string | undefined {
  const executable = entry.contractData().val().instance().executable();
  // Stellar Asset Contracts have no WASM (and therefore no code entry).
  if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) return undefined;
  return executable.wasmHash().toString("hex");
}

/**
 * Drop duplicate keys (same XDR), keeping the first occurrence. Two solvers
 * cannot share a bond key, but a misconfiguration (same contract ID for both
 * contracts) would otherwise put the same instance key in one footprint twice.
 */
export function dedupeKeys<T extends { keyXdr: string }>(keys: readonly T[]): T[] {
  const seen = new Set<string>();
  return keys.filter((k) => (seen.has(k.keyXdr) ? false : (seen.add(k.keyXdr), true)));
}

/**
 * Order keys for extension: critical kinds (instance, code) first, then by
 * remaining TTL ascending so the closest-to-archival entries are handled
 * before the budget runs out.
 */
export function prioritise<T extends { kind: TtlKeyKind; remainingLedgers: number }>(keys: readonly T[]): T[] {
  const rank = (k: T) => (CRITICAL_KINDS.includes(k.kind) ? 0 : 1);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.remainingLedgers - b.remainingLedgers);
}

/**
 * Split keys into transactions of at most `maxPerTx` keys. Soroban limits the
 * number of entries in a transaction footprint; the network limit is far above
 * the default `TTL_KEEPER_MAX_KEYS_PER_TX`, which also bounds per-tx fees.
 */
export function batchKeys<T>(keys: readonly T[], maxPerTx: number): T[][] {
  if (!Number.isInteger(maxPerTx) || maxPerTx < 1) throw new Error(`maxPerTx must be a positive integer, got ${maxPerTx}`);
  const batches: T[][] = [];
  for (let i = 0; i < keys.length; i += maxPerTx) batches.push(keys.slice(i, i + maxPerTx));
  return batches;
}
