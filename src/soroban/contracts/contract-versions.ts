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
 * Deployed WASM hashes the backend is known to be compatible with.
 *
 * Intentionally empty until the contracts ship a tagged release: with no
 * entry, a configured contract is reported as `unknown_hash` and writes stay
 * blocked (fail closed). The hash of a deployed contract is shown in
 * `GET /health` → `contracts.<name>.wasmHash`, or via
 * `stellar contract info wasm-hash --id <CONTRACT_ID>`.
 */
export const SUPPORTED_CONTRACT_VERSIONS: SupportedContractVersions = {
  settlement: {},
  solverRegistry: {},
};

/** DI token so tests (and future config-driven registries) can supply the map. */
export const CONTRACT_VERSION_REGISTRY = Symbol("CONTRACT_VERSION_REGISTRY");
