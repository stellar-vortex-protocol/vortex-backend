import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FeeBumpTransaction, SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

@Injectable()
export class SorobanService {
  private readonly server: SorobanRpc.Server;

  constructor(configService: ConfigService<AppConfig, true>) {
    const rpcUrl = configService.get("stellar.sorobanRpcUrl", { infer: true });
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  getHealth() {
    return this.server.getHealth();
  }

  getLatestLedger() {
    return this.server.getLatestLedger();
  }

  getNetwork() {
    return this.server.getNetwork();
  }

  getAccount(publicKey: string) {
    return this.server.getAccount(publicKey);
  }

  /** Simulates `tx` and returns it assembled with the resulting footprint/resource fees, ready to sign. */
  prepareTransaction(tx: Transaction): Promise<Transaction> {
    return this.server.prepareTransaction(tx);
  }

  /** Submits a signed transaction. Does not wait for it to land — see `getTransactionStatus`. */
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<SorobanRpc.Api.SendTransactionResponse> {
    return this.server.sendTransaction(tx);
  }

  /** Looks up a submitted transaction by hash; status is NOT_FOUND until it lands. */
  getTransactionStatus(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
    return this.server.getTransaction(hash);
  }
}
