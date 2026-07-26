import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair, Networks, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SorobanService } from "./soroban.service";

const NETWORK_PASSPHRASES: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

const REDACTED = "[redacted]";

/**
 * Holds the backend's Soroban hot-wallet key (env-injected secret, per the
 * on-chain settlement ADR), signs transactions with it, and manages that
 * account's sequence number.
 *
 * The raw secret is kept in a private field and is never included in thrown
 * errors, logs, or object inspection (see the custom inspect override below).
 * Presence is enforced for production by `env.validation.ts`; outside
 * production it may be unset, in which case signing operations throw a clear
 * error rather than the app failing to boot.
 *
 * Sequence numbers are managed in-process rather than by calling
 * `getAccount()` per request: Soroban requires the *exact* next sequence
 * number, and two concurrent submissions from this same signing account that
 * each independently fetched "the current sequence" would both try to use
 * it, so one would be rejected. `withNextSequence` serializes access with an
 * in-process lock and hands out a fresh, already-incremented number per call.
 */
@Injectable()
export class SignerService {
  private readonly secretKey: string;
  private readonly networkPassphrase: string;
  private keypair: Keypair | null = null;

  // Chains sequence acquisitions so they run one at a time, in call order.
  private sequenceLock: Promise<void> = Promise.resolve();
  private cachedSequence: bigint | null = null;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly sorobanService: SorobanService,
  ) {
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

  /**
   * Runs `fn` with the next sequence number for the signing account, holding
   * an in-process lock for the duration so no other caller can be handed the
   * same sequence number concurrently.
   *
   * The sequence is fetched from the network once and cached; every call
   * after that increments the cached value locally rather than re-fetching.
   * If `fn` throws — e.g. the transaction it built was never accepted by the
   * network — the cache is dropped so the next call re-syncs from the
   * network instead of drifting out of step with the account's real state.
   */
  async withNextSequence<T>(fn: (sequence: string) => Promise<T>): Promise<T> {
    let releaseLock!: () => void;
    const previous = this.sequenceLock;
    this.sequenceLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;

    try {
      const sequence = await this.nextSequence();
      return await fn(sequence);
    } catch (err) {
      this.cachedSequence = null;
      throw err;
    } finally {
      releaseLock();
    }
  }

  private async nextSequence(): Promise<string> {
    if (this.cachedSequence === null) {
      const account = await this.sorobanService.getAccount(this.getPublicKey());
      this.cachedSequence = BigInt(account.sequenceNumber());
    }
    this.cachedSequence += 1n;
    return this.cachedSequence.toString();
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
