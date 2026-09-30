/**
 * VaultTransitSigner (issue #400 — Pluggable Remote Signer Backends)
 * ────────────────────────────────────────────────────────────────────
 * Signs Stellar transactions and Soroban auth entries via HashiCorp Vault's
 * Transit secrets engine (Ed25519), so the raw signing key never resides in
 * process memory or environment variables.
 *
 * Required env vars:
 *   VAULT_ADDR   — e.g. https://vault.internal:8200
 *   VAULT_TOKEN  — Vault token with `transit/sign/<key>` capability
 *   VAULT_TRANSIT_KEY_NAME — Transit key name (default: "vortex-signer")
 *
 * How it works
 * ────────────
 * Vault Transit exposes `POST /v1/transit/sign/<key>` which takes a
 * base64-encoded input and returns a base64-encoded Ed25519 signature.
 * The signature is then injected into the Stellar transaction's decorated
 * signature list, exactly as a local keypair would do.
 *
 * The Ed25519 public key is fetched once on module init via
 * `GET /v1/transit/keys/<key>` and cached — it changes only when Vault
 * rotates the key (which requires an operator action; rotation is out of
 * scope for this issue).
 *
 * Failure behaviour
 * ─────────────────
 * Vault unavailability MUST fail writes closed.  This signer throws rather
 * than falling back to a local key — preventing a degraded-mode footgun
 * where a network partition silently re-enables in-process signing.
 *
 * See: https://developer.hashicorp.com/vault/docs/secrets/transit
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { ISigner } from "./signer.interface";
import { MetricsService } from "../../metrics/metrics.service";

const TRANSIT_SIGN_PATH = (key: string) => `/v1/transit/sign/${key}`;
const TRANSIT_KEYS_PATH = (key: string) => `/v1/transit/keys/${key}`;

@Injectable()
export class VaultTransitSigner implements ISigner, OnModuleInit {
  private readonly logger = new Logger(VaultTransitSigner.name);

  private readonly vaultAddr: string;
  private readonly vaultToken: string;
  private readonly keyName: string;
  private readonly _networkPassphrase: string;

  /** Cached Ed25519 public key fetched from Vault at init. */
  private cachedPublicKey: string | null = null;

  constructor(
    vaultAddr: string,
    vaultToken: string,
    keyName: string,
    networkPassphrase: string,
    private readonly metricsService?: MetricsService,
  ) {
    this.vaultAddr = vaultAddr.replace(/\/$/, "");
    this.vaultToken = vaultToken;
    this.keyName = keyName;
    this._networkPassphrase = networkPassphrase;
  }

  async onModuleInit(): Promise<void> {
    // Eagerly fetch + cache the public key.  Fails fast if Vault is unreachable.
    await this.fetchPublicKey();
    this.logger.log(
      `[vault-transit] initialised: key=${this.keyName} publicKey=${this.cachedPublicKey}`,
    );
  }

  publicKey(): string {
    if (!this.cachedPublicKey) {
      throw new Error(
        "VaultTransitSigner: public key not yet initialised (onModuleInit must complete first)",
      );
    }
    return this.cachedPublicKey;
  }

  networkPassphrase(): string {
    return this._networkPassphrase;
  }

  async signTransaction<T extends Transaction | FeeBumpTransaction>(transaction: T): Promise<T> {
    const start = Date.now();
    try {
      // Compute the transaction hash (the payload Vault will sign).
      const txHash = transaction.hash();
      const signature = await this.vaultSign(txHash);

      // Build a Stellar decorated signature and add it to the transaction.
      const kp = Keypair.fromPublicKey(this.publicKey());
      const decoratedSig = new xdr.DecoratedSignature({
        hint: kp.signatureHint(),
        signature: Buffer.from(signature),
      });

      transaction.signatures.push(decoratedSig);
      return transaction;
    } finally {
      try {
        this.metricsService?.observeSignerCall("vault", "signTransaction", (Date.now() - start) / 1000);
      } catch { /* noop */ }
    }
  }

  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const start = Date.now();
    try {
      const credType = entry.credentials().switch();
      if (
        credType.name !== "sorobanCredentialsAddress" &&
        credType.value !== 1 /* SOROBAN_CREDENTIALS_ADDRESS */
      ) {
        return entry;
      }

      const addressCreds = entry.credentials().address();
      const payload = Buffer.concat([
        Buffer.from(this._networkPassphrase),
        entry.toXDR(),
      ]);
      const signature = await this.vaultSign(payload);

      addressCreds.signature(
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("public_key"),
            val: xdr.ScVal.scvBytes(
              Buffer.from(Keypair.fromPublicKey(this.publicKey()).rawPublicKey()),
            ),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("signature"),
            val: xdr.ScVal.scvBytes(Buffer.from(signature)),
          }),
        ]),
      );

      return entry;
    } finally {
      try {
        this.metricsService?.observeSignerCall("vault", "signAuthEntry", (Date.now() - start) / 1000);
      } catch { /* noop */ }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Call `POST /v1/transit/sign/<key>` and return the raw 64-byte Ed25519
   * signature as a Buffer.
   *
   * Vault returns signatures in the form `vault:v1:<base64>`.  We strip the
   * prefix before returning the raw bytes to the Stellar SDK.
   */
  private async vaultSign(payload: Buffer): Promise<Buffer> {
    const url = `${this.vaultAddr}${TRANSIT_SIGN_PATH(this.keyName)}`;
    const body = JSON.stringify({
      input: payload.toString("base64"),
    });

    let res: Response;
    try {
      // eslint-disable-next-line no-restricted-syntax -- pre-existing direct fetch; HttpEgressService migration is a separate change
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": this.vaultToken,
        },
        body,
      });
    } catch (err) {
      // Network-level failure — fail closed (no fallback).
      throw new Error(
        `VaultTransitSigner: Vault unreachable at ${this.vaultAddr}: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `VaultTransitSigner: Vault sign request failed (HTTP ${res.status}): ${errBody}`,
      );
    }

    const json = (await res.json()) as { data?: { signature?: string } };
    const rawSig = json?.data?.signature;
    if (!rawSig || typeof rawSig !== "string") {
      throw new Error("VaultTransitSigner: unexpected Vault sign response shape");
    }

    // Strip `vault:v1:` prefix, decode the rest from base64.
    const b64 = rawSig.replace(/^vault:v\d+:/, "");
    return Buffer.from(b64, "base64");
  }

  /**
   * Fetch the Ed25519 public key from Vault's key metadata endpoint.
   * Vault returns the public key in base64; we convert it to a Stellar
   * G-address via the Keypair utility.
   */
  private async fetchPublicKey(): Promise<void> {
    const url = `${this.vaultAddr}${TRANSIT_KEYS_PATH(this.keyName)}`;

    let res: Response;
    try {
      // eslint-disable-next-line no-restricted-syntax -- pre-existing direct fetch; HttpEgressService migration is a separate change
      res = await fetch(url, {
        method: "GET",
        headers: { "X-Vault-Token": this.vaultToken },
      });
    } catch (err) {
      throw new Error(
        `VaultTransitSigner: cannot reach Vault at ${this.vaultAddr} to fetch public key: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `VaultTransitSigner: Vault keys request failed (HTTP ${res.status}): ${errBody}`,
      );
    }

    const json = (await res.json()) as {
      data?: {
        keys?: Record<string, { public_key?: string }>;
        latest_version?: number;
      };
    };

    const latestVersion = json?.data?.latest_version ?? 1;
    const keyEntry = json?.data?.keys?.[String(latestVersion)];
    const rawPublicKey = keyEntry?.public_key;

    if (!rawPublicKey || typeof rawPublicKey !== "string") {
      throw new Error(
        `VaultTransitSigner: could not extract Ed25519 public key from Vault Transit keys response`,
      );
    }

    // Convert the raw Ed25519 public key bytes to a Stellar G-address.
    // Vault returns the raw 32-byte Ed25519 public key as base64.
    // We use StrKey to encode it as a Stellar G-address.
    const rawBytes = Buffer.from(rawPublicKey, "base64");
    // Import StrKey from the SDK to encode the raw public key as a G-address.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { StrKey } = require("@stellar/stellar-sdk");
    this.cachedPublicKey = StrKey.encodeEd25519PublicKey(rawBytes);
  }

  // ── Redaction guarantees ───────────────────────────────────────────────────

  toString(): string {
    return `VaultTransitSigner(key=${this.keyName}, vault=${this.vaultAddr}, publicKey=${this.cachedPublicKey ?? "not-yet-fetched"})`;
  }

  toJSON(): unknown {
    return {
      backend: "vault",
      keyName: this.keyName,
      vaultAddr: this.vaultAddr,
      vaultToken: "[redacted]",
      publicKey: this.cachedPublicKey,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}
