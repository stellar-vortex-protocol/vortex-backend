import { SupportedChain } from "../intents/intents.types";
import { STELLAR_TOKENS, SUPPORTED_TOKENS } from "./tokens.data";
import { ITokensRepository, TokenRecord, TokenStatus } from "./tokens.repository";

export class InMemoryTokensRepository implements ITokensRepository {
  private generation = 0;
  private readonly records: TokenRecord[] = [
    ...Object.entries(SUPPORTED_TOKENS).flatMap(([chain, tokens]) =>
      tokens.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        chain: chain as SupportedChain,
        priceUsd: token.priceUSD,
        isStellar: false,
      })),
    ),
    ...STELLAR_TOKENS.map((token) => ({
      address: token.contract,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      chain: "stellar" as const,
      priceUsd: token.priceUSD,
      isStellar: true,
    })),
  ];

  findAll(): TokenRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  findByChain(chain: SupportedChain | string): TokenRecord[] {
    const normalized = String(chain).toLowerCase();
    return this.records
      .filter((record) => record.chain === normalized || record.chain === chain)
      .map((record) => ({ ...record }));
  }

  findByAddressAndChain(address: string, chain: SupportedChain | string): TokenRecord | undefined {
    const normalizedAddress = address.trim().toLowerCase();
    const chainName = String(chain).toLowerCase();
    const match = this.records.find(
      (record) =>
        record.address.toLowerCase() === normalizedAddress && record.chain === chainName,
    );
    return match ? { ...match } : undefined;
  }

  /**
   * Insert or replace the row for `(address, chain)` and bump the cache
   * generation so callers can observe the invalidation (issue #404).
   */
  async save(record: TokenRecord): Promise<TokenRecord> {
    const stored: TokenRecord = { ...record, status: record.status ?? "active" };
    const normalizedAddress = record.address.trim().toLowerCase();
    const chainName = String(record.chain).toLowerCase();
    const index = this.records.findIndex(
      (existing) =>
        existing.address.toLowerCase() === normalizedAddress && existing.chain === chainName,
    );
    if (index >= 0) this.records[index] = stored;
    else this.records.push(stored);
    this.generation += 1;
    return { ...stored };
  }

  /** Soft status change; undefined when the token is not registered. */
  async setStatus(
    address: string,
    chain: SupportedChain | string,
    status: TokenStatus,
  ): Promise<TokenRecord | undefined> {
    const existing = this.findByAddressAndChain(address, chain);
    if (!existing) return undefined;
    return this.save({ ...existing, status });
  }

  cacheGeneration(): number {
    return this.generation;
  }
}
