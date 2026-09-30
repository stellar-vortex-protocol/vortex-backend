/**
 * LocalKeypairSigner (issue #400)
 * ────────────────────────────────
 * Wraps the existing SignerService key-loading and signing logic behind the
 * ISigner interface.  This preserves existing behaviour exactly while making
 * it swappable for VaultTransitSigner in production.
 *
 * Production guard: this signer is refused at bootstrap when NODE_ENV=production
 * unless ALLOW_LOCAL_SIGNER_IN_PROD=true is explicitly set.  The guard
 * prevents accidentally deploying with a secret-in-env key after Vault is
 * configured (see env.validation.ts and the SECURITY.md key custody model).
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FeeBumpTransaction,
  Keypair,
  Networks,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { AppConfig } from "../../config/configuration";
import { ISigner } from "./signer.interface";
import { MetricsService } from "../../metrics/metrics.service";

const NETWORK_PASSPHRASES: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

const REDACTED = "[redacted]";

@Injectable()
export class LocalKeypairSigner implements ISigner, OnModuleInit {
  private readonly logger = new Logger(LocalKeypairSigner.name);
  private readonly secretKey: string;
  private readonly _networkPassphrase: string;
  private keypair: Keypair | null = null;

  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly metricsService?: MetricsService,
  ) {
    const configuredSecret = configService.get("stellar.signingKey", { infer: true });
    const secretFile = process.env.SOROBAN_SIGNING_KEY_FILE?.trim();
    this.secretKey = secretFile ? readFileSync(secretFile, "utf8").trim() : configuredSecret;
    this._networkPassphrase =
      NETWORK_PASSPHRASES[configService.get("stellar.network", { infer: true })];
  }

  onModuleInit(): void {
    const nodeEnv = process.env.NODE_ENV ?? "development";
    const allowLocal = (process.env.ALLOW_LOCAL_SIGNER_IN_PROD ?? "false").toLowerCase() === "true";

    if (nodeEnv === "production" && !allowLocal) {
      throw new Error(
        "LocalKeypairSigner cannot be used in production without ALLOW_LOCAL_SIGNER_IN_PROD=true. " +
        "Configure SIGNER_BACKEND=vault and provide VAULT_ADDR / VAULT_TOKEN instead. " +
        "See SECURITY.md for the key custody model.",
      );
    }

    if (nodeEnv === "production" && allowLocal) {
      this.logger.warn(
        "LocalKeypairSigner is active in production (ALLOW_LOCAL_SIGNER_IN_PROD=true). " +
        "This is not recommended — migrate to VaultTransitSigner for key custody.",
      );
    }
  }

  /** Whether a signer secret has been configured. False in dev/test by default. */
  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  publicKey(): string {
    return this.getKeypair().publicKey();
  }

  networkPassphrase(): string {
    return this._networkPassphrase;
  }

  async signTransaction<T extends Transaction | FeeBumpTransaction>(transaction: T): Promise<T> {
    const start = Date.now();
    transaction.sign(this.getKeypair());
    const elapsed = (Date.now() - start) / 1000;
    try {
      this.metricsService?.observeSignerCall("local", "signTransaction", elapsed);
    } catch { /* noop */ }
    return transaction;
  }

  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const start = Date.now();
    try {
      // Only SOROBAN_CREDENTIALS_ADDRESS entries require signing.
      const credType = entry.credentials().switch();
      if (
        credType.name !== "sorobanCredentialsAddress" &&
        credType.value !== 1 /* SOROBAN_CREDENTIALS_ADDRESS */
      ) {
        return entry;
      }

      const addressCreds = entry.credentials().address();
      // Hash the auth entry XDR as the signing payload (network-passphrase-prefixed).
      const payload = Buffer.concat([
        Buffer.from(this._networkPassphrase),
        entry.toXDR(),
      ]);
      const sig = this.getKeypair().sign(payload);

      addressCreds.signature(
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("public_key"),
            val: xdr.ScVal.scvBytes(Buffer.from(this.getKeypair().rawPublicKey())),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("signature"),
            val: xdr.ScVal.scvBytes(Buffer.from(sig)),
          }),
        ]),
      );

      return entry;
    } finally {
      const elapsed = (Date.now() - start) / 1000;
      try {
        this.metricsService?.observeSignerCall("local", "signAuthEntry", elapsed);
      } catch { /* noop */ }
    }
  }

  private getKeypair(): Keypair {
    if (!this.secretKey) {
      throw new Error("Soroban signer is not configured: set SOROBAN_SIGNING_KEY");
    }
    if (!this.keypair) {
      this.keypair = Keypair.fromSecret(this.secretKey);
    }
    return this.keypair;
  }

  // ── Redaction guarantees (mirrors existing SignerService) ─────────────────

  toString(): string {
    return `LocalKeypairSigner(publicKey=${this.isConfigured() ? this.publicKey() : "unconfigured"}, secretKey=${REDACTED})`;
  }

  toJSON(): unknown {
    return { publicKey: this.isConfigured() ? this.publicKey() : null, secretKey: REDACTED };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
