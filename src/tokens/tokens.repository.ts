import { SupportedChain } from "../intents/intents.types";

/** Discovery and create-path lifecycle. Delisted rows are retained. */
export type TokenStatus = "active" | "paused" | "delisted";

/** How the address was verified. Classic Stellar assets are not SACs. */
export type TokenAssetKind = "evm" | "stellar-sac" | "stellar-classic";

export interface TokenRecord {
  id?: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoUri?: string | null;
  priceUsd?: number | null;
  isStellar: boolean;
  /** Missing on older in-memory seeds is treated as active. */
  status?: TokenStatus;
  assetKind?: TokenAssetKind;
}

export const TOKENS_REPOSITORY = Symbol("TOKENS_REPOSITORY");

export interface ITokensRepository {
  findAll(): TokenRecord[];
  findByChain(chain: SupportedChain | string): TokenRecord[];
  findByAddressAndChain(address: string, chain: SupportedChain | string): TokenRecord | undefined;
  /**
   * Insert or replace the row for `(address, chain)` and drop any cached copy.
   * Must not be called with metadata that failed on-chain verification.
   */
  save(record: TokenRecord): Promise<TokenRecord>;
  /** Soft status change. Returns undefined when the token is not registered. */
  setStatus(address: string, chain: SupportedChain | string, status: TokenStatus): Promise<TokenRecord | undefined>;
  /** Bumps on every successful mutation so callers can observe cache invalidation. */
  cacheGeneration(): number;
}
