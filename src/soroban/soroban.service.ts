import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc } from "@stellar/stellar-sdk";
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
}
