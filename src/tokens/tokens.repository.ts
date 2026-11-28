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

/** A single registry mutation, mirroring `TokenListUpdatedEvent` plus a timestamp. */
export interface TokenChangelogEntry {
  /** Monotonic cursor; strictly increasing across appends. */
  seq: number;
  /** `cacheGeneration()` value at the time the mutation was recorded. */
  generation: number;
  action: "created" | "updated" | "delisted";
  address: string;
  chain: SupportedChain;
  symbol?: string;
  /** ISO-8601 timestamp of when the mutation was recorded. */
  timestamp: string;
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
  /**
   * Append a registry mutation to the bounded changelog (last N entries).
   * Called from the same publish hook that emits `TokenListUpdatedEvent`.
   */
  appendChangelog(entry: Omit<TokenChangelogEntry, "seq" | "generation" | "timestamp">): TokenChangelogEntry;
  /**
   * Return changelog entries after `cursor`. `cursor` may be a `seq` number,
   * a `cacheGeneration()` value, or an ISO timestamp; omitted returns all retained.
   */
  changelog(since?: string | number): TokenChangelogEntry[];
}
