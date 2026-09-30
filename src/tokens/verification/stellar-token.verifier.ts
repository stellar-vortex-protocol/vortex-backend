import { VerifiedTokenMetadata } from "./evm-token.verifier";

/**
 * Reads SEP-41 `symbol` / `decimals` / `name` for a Stellar Asset Contract.
 * Returning null means the contract is not on the ledger.
 */
export interface StellarSacReader {
  read(contractId: string): Promise<{ symbol: string; decimals: number; name: string | null } | null>;
}

export class StellarVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellarVerificationError";
  }
}

const CLASSIC_ASSET = /^[A-Z0-9]{1,12}:G[A-Z2-7]{55}$/;
const SAC_CONTRACT = /^C[A-Z2-7]{55}$/;

/**
 * Stellar verification distinguishes classic assets (`CODE:ISSUER` or native
 * XLM, always 7 decimals) from SACs, whose metadata comes from the contract.
 */
export class StellarTokenVerifier {
  constructor(private readonly sac: StellarSacReader) {}

  async verify(address: string): Promise<VerifiedTokenMetadata> {
    const trimmed = address.trim();
    if (trimmed === "native" || trimmed.toUpperCase() === "XLM") {
      return { assetKind: "stellar-classic", decimals: 7, symbol: "XLM", name: "Stellar Lumens", exists: true };
    }
    if (CLASSIC_ASSET.test(trimmed)) {
      const symbol = trimmed.slice(0, trimmed.indexOf(":"));
      return { assetKind: "stellar-classic", decimals: 7, symbol, name: symbol, exists: true };
    }
    if (!SAC_CONTRACT.test(trimmed)) {
      throw new StellarVerificationError(`'${address}' is not a Stellar classic asset or SAC contract`);
    }
    const meta = await this.sac.read(trimmed);
    if (!meta) {
      return { assetKind: "stellar-sac", decimals: 0, symbol: "", name: null, exists: false };
    }
    if (!meta.symbol || !Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 255) {
      throw new StellarVerificationError(`SAC ${trimmed} returned invalid metadata`);
    }
    return {
      assetKind: "stellar-sac",
      decimals: meta.decimals,
      symbol: meta.symbol,
      name: meta.name,
      exists: true,
    };
  }
}
