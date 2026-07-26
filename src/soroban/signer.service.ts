import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair, Networks, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

const NETWORK_PASSPHRASES: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

const REDACTED = "[redacted]";

/**
 * Holds the backend's Soroban hot-wallet key (env-injected secret, per the
 * on-chain settlement ADR) and signs transactions with it.
 *
 * The raw secret is kept in a private field and is never included in thrown
 * errors, logs, or object inspection (see the custom inspect override below).
 * Presence is enforced for production by `env.validation.ts`; outside
 * production it may be unset, in which case signing operations throw a clear
 * error rather than the app failing to boot.
 */
@Injectable()
export class SignerService {
  private readonly secretKey: string;
  private readonly networkPassphrase: string;
  private keypair: Keypair | null = null;

  constructor(configService: ConfigService<AppConfig, true>) {
    this.secretKey = configService.get("stellar.signerSecretKey", { infer: true });
    this.networkPassphrase = NETWORK_PASSPHRASES[configService.get("stellar.network", { infer: true })];
  }

  /** Whether a signer secret has been configured. False in dev/test by default. */
  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  getPublicKey(): string {
    return this.getKeypair().publicKey();
  }

  sign<T extends Transaction | FeeBumpTransaction>(transaction: T): T {
    transaction.sign(this.getKeypair());
    return transaction;
  }

  private getKeypair(): Keypair {
    if (!this.secretKey) {
      throw new Error("Soroban signer is not configured: set SOROBAN_SIGNER_SECRET_KEY");
    }
    if (!this.keypair) {
      this.keypair = Keypair.fromSecret(this.secretKey);
    }
    return this.keypair;
  }

  toString(): string {
    return `SignerService(publicKey=${this.isConfigured() ? this.getPublicKey() : "unconfigured"}, secretKey=${REDACTED})`;
  }

  toJSON(): unknown {
    return { publicKey: this.isConfigured() ? this.getPublicKey() : null, secretKey: REDACTED };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
