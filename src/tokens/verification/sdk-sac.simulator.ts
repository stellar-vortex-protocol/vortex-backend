import { Account, Contract, Networks, SorobanRpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { SacSimulator } from "./simulated-sac.reader";

/**
 * Production SAC reader. Simulations are read-only: nothing is signed or
 * submitted. `SHADOW_SOURCE_ACCOUNT` is only the envelope source.
 */
export class SdkSacSimulator implements SacSimulator {
  private readonly server: SorobanRpc.Server;
  private readonly passphrase: string;

  constructor(
    rpcUrl: string,
    private readonly sourceAccount: string,
    network: string,
  ) {
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.passphrase =
      network === "mainnet" ? Networks.PUBLIC : network === "futurenet" ? Networks.FUTURENET : Networks.TESTNET;
  }

  async simulate(contractId: string, method: "symbol" | "decimals" | "name"): Promise<xdr.ScVal | null> {
    if (!this.sourceAccount) {
      throw new Error("SHADOW_SOURCE_ACCOUNT is required to verify Stellar SAC metadata");
    }
    const tx = new TransactionBuilder(new Account(this.sourceAccount, "0"), {
      fee: "100",
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contractId).call(method))
      .setTimeout(30)
      .build();
    const response = await this.server.simulateTransaction(tx);
    return retvalFromSimulation(response);
  }
}

/** Pull the first simulated return value out of a Soroban RPC response. */
export function retvalFromSimulation(response: unknown): xdr.ScVal | null {
  if (!response || typeof response !== "object") return null;
  const record = response as { error?: unknown; results?: Array<{ retval?: xdr.ScVal }> };
  if (typeof record.error === "string" && record.error.length > 0) return null;
  const retval = record.results?.[0]?.retval;
  return retval ?? null;
}
