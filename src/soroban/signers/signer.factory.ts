/**
 * Signer factory (issue #400)
 * ────────────────────────────
 * Selects the appropriate ISigner implementation at bootstrap based on the
 * SIGNER_BACKEND env var:
 *
 *   SIGNER_BACKEND=local  (default) → LocalKeypairSigner
 *   SIGNER_BACKEND=vault           → VaultTransitSigner
 *
 * Production behaviour:
 *   • With SIGNER_BACKEND=local: boot is refused unless
 *     ALLOW_LOCAL_SIGNER_IN_PROD=true is explicitly set (enforced inside
 *     LocalKeypairSigner.onModuleInit).
 *   • With SIGNER_BACKEND=vault: VAULT_ADDR and VAULT_TOKEN are required
 *     (validated by env.validation.ts).
 */

import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { LocalKeypairSigner } from "./local-keypair.signer";
import { VaultTransitSigner } from "./vault-transit.signer";
import { ISigner, SIGNER_TOKEN } from "./signer.interface";
import { MetricsService } from "../../metrics/metrics.service";
import { Networks } from "@stellar/stellar-sdk";

const NETWORK_PASSPHRASES: Record<AppConfig["stellar"]["network"], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

/**
 * NestJS provider factory for ISigner.
 *
 * Register this in SorobanModule's providers array:
 *
 * ```ts
 * {
 *   provide: SIGNER_TOKEN,
 *   inject: [ConfigService, MetricsService],
 *   useFactory: signerFactory,
 * }
 * ```
 */
export function signerFactory(
  configService: ConfigService<AppConfig, true>,
  metricsService: MetricsService,
): ISigner {
  const backend = (process.env.SIGNER_BACKEND ?? "local").toLowerCase();

  if (backend === "vault") {
    const vaultAddr = process.env.VAULT_ADDR ?? "";
    const vaultToken = process.env.VAULT_TOKEN ?? "";
    const keyName = process.env.VAULT_TRANSIT_KEY_NAME ?? "vortex-signer";
    const network = configService.get("stellar.network", { infer: true });
    const passphrase = NETWORK_PASSPHRASES[network];

    if (!vaultAddr || !vaultToken) {
      throw new Error(
        "SIGNER_BACKEND=vault requires VAULT_ADDR and VAULT_TOKEN to be set. " +
        "See SECURITY.md for the key custody model.",
      );
    }

    return new VaultTransitSigner(vaultAddr, vaultToken, keyName, passphrase, metricsService);
  }

  // Default: local keypair.
  return new LocalKeypairSigner(configService, metricsService);
}

export { SIGNER_TOKEN };
