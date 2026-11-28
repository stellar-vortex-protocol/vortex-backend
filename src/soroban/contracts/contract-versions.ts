/**
 * Contract version registry (issue #402).
 *
 * Soroban contracts can be upgraded in place, which swaps the WASM behind a
 * contract ID without changing the ID. The backend encodes calls for a
 * specific ABI, so every deployed WASM hash it may talk to must be mapped to
 * the ABI version whose codec it should use. A hash missing from this map is
 * treated as unknown: ContractVersionService puts the backend in read-only
 * mode for that contract until a reviewed change adds it here.
 *
 * To support a new deployment or upgrade, follow
 * docs/runbooks/contract-upgrades.md — never add a hash without confirming
 * the matching codec in ./settlement.client.ts / ./solver-registry.client.ts
 * encodes its ABI correctly.
 *
 * Runtime-managed entries (issue #662) are persisted via
 * ContractVersionRegistryRepository and layered on top of the static seed
 * below; the static map remains the default so existing deployments keep
 * working unmodified.
 */

/** Contracts the backend writes to. */
export const CONTRACT_NAMES = ["settlement", "solverRegistry"] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

/** ABI versions the backend has a codec for, per contract. */
export type SettlementAbiVersion = "settlement-v1";
export type SolverRegistryAbiVersion = "solver-registry-v1";

export interface AbiVersionByContract {
  settlement: SettlementAbiVersion;
  solverRegistry: SolverRegistryAbiVersion;
}

/** WASM hash (lower-case hex) → ABI version, per contract. */
export type SupportedContractVersions = {
  [C in ContractName]: Readonly<Record<string, AbiVersionByContract[C]>>;
};

/**
 * ABI versions the backend has a codec for, per contract. Used to validate
 * runtime registrations so the admin API cannot point the gate at an ABI
 * nothing in the codebase actually encodes for.
 */
export const SUPPORTED_ABI_VERSIONS: {
  [C in ContractName]: readonly AbiVersionByContract[C][];
} = {
  settlement: ["settlement-v1"],
  solverRegistry: ["solver-registry-v1"],
};

/**
 * Deployed WASM hashes the backend is known to be compatible with.
 *
 * Intentionally empty until the contracts ship a tagged release: with no
 * entry, a configured contract is reported as `unknown_hash` and writes stay
 * blocked (fail closed). The hash of a deployed contract is shown in
 * `GET /health` → `contracts.<name>.wasmHash`, or via
 * `stellar contract info wasm-hash --id <CONTRACT_ID>`.
 *
 * This map is the seed/default; runtime registrations are layered on top.
 */
export const SUPPORTED_CONTRACT_VERSIONS: SupportedContractVersions = {
  settlement: {},
  solverRegistry: {},
};

/** DI token so tests (and future config-driven registries) can supply the map. */
export const CONTRACT_VERSION_REGISTRY = Symbol("CONTRACT_VERSION_REGISTRY");

/**
 * Returns true when `abiVersion` is one of the codec-supported literal types
 * for `contract`. Used by the admin API to reject unknown ABIs.
 */
export function isSupportedAbiVersion<C extends ContractName>(
  contract: C,
  abiVersion: string,
): abiVersion is AbiVersionByContract[C] {
  return (SUPPORTED_ABI_VERSIONS[contract] as readonly string[]).includes(
    abiVersion,
  );
}
