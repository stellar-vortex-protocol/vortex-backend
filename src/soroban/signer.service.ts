import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Account, Keypair, Transaction } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SorobanService } from "./soroban.service";

@Injectable()
export class SignerService {
  private keypair?: Keypair;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly sorobanService: SorobanService,
  ) {
  }

  get publicKey(): string {
    return this.getKeypair().publicKey();
  }

  async withNextSequence<T>(callback: (account: Account) => Promise<T>): Promise<T> {
    const account = await this.sorobanService.getAccount(this.publicKey);
    return callback(account);
  }

  sign(transaction: Transaction): Transaction {
    transaction.sign(this.getKeypair());
    return transaction;
  }

  private getKeypair(): Keypair {
    if (this.keypair) return this.keypair;
    const secret = this.configService.get("stellar.signerSecretKey", { infer: true });
    if (!secret) throw new ServiceUnavailableException("STELLAR_SIGNER_SECRET_KEY is not configured");
    this.keypair = Keypair.fromSecret(secret);
    return this.keypair;
  }
}
