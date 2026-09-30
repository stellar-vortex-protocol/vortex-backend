import { xdr } from "@stellar/stellar-sdk";
import { StellarSacReader } from "./stellar-token.verifier";

/** One simulated SEP-41 call. Production uses Soroban RPC; tests return fixtures. */
export interface SacSimulator {
  simulate(contractId: string, method: "symbol" | "decimals" | "name"): Promise<xdr.ScVal | null>;
}

/**
 * Pull symbol, decimals and name off a SAC by simulation.
 * A null `symbol` or `decimals` simulation means the contract is absent.
 */
export class SimulatedSacReader implements StellarSacReader {
  constructor(private readonly simulator: SacSimulator) {}

  async read(contractId: string): Promise<{ symbol: string; decimals: number; name: string | null } | null> {
    const symbolVal = await this.simulator.simulate(contractId, "symbol");
    const decimalsVal = await this.simulator.simulate(contractId, "decimals");
    if (!symbolVal || !decimalsVal) return null;
    const symbol = scValToString(symbolVal);
    const decimals = scValToUint(decimalsVal);
    if (!symbol || decimals === null) return null;
    let name: string | null = null;
    try {
      const nameVal = await this.simulator.simulate(contractId, "name");
      name = nameVal ? scValToString(nameVal) : null;
    } catch {
      name = null;
    }
    return { symbol, decimals, name };
  }
}

/** Decode a Soroban string, symbol, or bytes ScVal. Exported for fixture tests. */
export function scValToString(val: xdr.ScVal): string | null {
  const kind = val.switch().name;
  let raw: string | Buffer | null = null;
  if (kind === "scvString") raw = val.str();
  else if (kind === "scvSymbol") raw = val.sym();
  else if (kind === "scvBytes") raw = val.bytes();
  else return null;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const trimmed = text.replace(/\0+$/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Decode a Soroban unsigned integer ScVal used by SAC `decimals()`. */
export function scValToUint(val: xdr.ScVal): number | null {
  const kind = val.switch().name;
  if (kind === "scvU32") return val.u32();
  if (kind === "scvI32") return val.i32();
  if (kind === "scvU64") return Number(val.u64().toString());
  return null;
}
