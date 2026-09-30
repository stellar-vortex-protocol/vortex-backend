import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SolverRegistryAbiVersion } from "./contract-versions";

/** Encodes solver-registry calls for one ABI version. */
export interface SolverRegistryCodec {
  slash(solverAddress: string, intentId: string): { method: string; args: xdr.ScVal[] };
}

/**
 * One codec per supported solver-registry ABI (issue #402). Used by
 * SolverRegistryService after ContractVersionService resolves the deployed
 * ABI from the contract's WASM hash.
 */
export const SOLVER_REGISTRY_CODECS: Record<SolverRegistryAbiVersion, SolverRegistryCodec> = {
  "solver-registry-v1": {
    slash: (solverAddress, intentId) => ({
      method: "slash",
      args: [Address.fromString(solverAddress).toScVal(), nativeToScVal(intentId, { type: "string" })],
    }),
  },
};
