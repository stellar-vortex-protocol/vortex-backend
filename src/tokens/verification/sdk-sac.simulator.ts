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

  /**
   * Read-only `balance_of(id)` simulation against a SAC contract. Returns the
   * raw i128 base-unit balance as a string, or `null` when the contract has no
   * entry for the account (treated as zero by callers). Throws on RPC failure
   * so callers can distinguish a failed simulate from a genuine zero balance.
   */
  async balanceOf(contractId: string, accountId: string): Promise<string | null> {
    if (!this.sourceAccount) {
      throw new Error("SHADOW_SOURCE_ACCOUNT is required to read Stellar SAC balances");
    }
    const tx = new TransactionBuilder(new Account(this.sourceAccount, "0"), {
      fee: "100",
      networkPassphrase: this.passphrase,
    })
      .addOperation(
        new Contract(contractId).call(
          "balance",
          xdr.ScVal.scvAddress(
            xdr.ScAddress.scAddressTypeAccount(
              xdr.PublicKey.publicKeyTypeEd25519(
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                Buffer.from(require("@stellar/stellar-base").StrKey.decodeEd25519PublicKey(accountId)),
              ),
            ),
          ),
        ),
      )
      .setTimeout(30)
      .build();
    const response = await this.server.simulateTransaction(tx);
    const record = response as { error?: unknown };
    if (typeof record.error === "string" && record.error.length > 0) {
      throw new Error(`Soroban simulate failed for ${contractId}: ${record.error}`);
    }
    const retval = retvalFromSimulation(response);
    if (!retval) return null;
    return scValToI128String(retval);
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

/** Convert an i128 ScVal return value into its base-unit decimal string. */
export function scValToI128String(value: xdr.ScVal): string {
  const i128 = value.i128();
  const hi = BigInt(i128.hi().toString());
  const lo = BigInt(i128.lo().toString());
  return ((hi << 64n) + lo).toString();
}
