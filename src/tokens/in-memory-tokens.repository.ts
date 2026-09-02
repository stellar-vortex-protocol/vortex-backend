import { SupportedChain } from "../intents/intents.types";
import { STELLAR_TOKENS, SUPPORTED_TOKENS } from "./tokens.data";
import { ITokensRepository, TokenRecord } from "./tokens.repository";

export class InMemoryTokensRepository implements ITokensRepository {
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
    const normalizedAddress = address.trim();
    const chainName = String(chain).toLowerCase();
    return this.records.find(
      (record) =>
        record.address.toLowerCase() === normalizedAddress.toLowerCase() &&
        record.chain === chainName,
    )
      ? { ...this.records.find((record) => record.address.toLowerCase() === normalizedAddress.toLowerCase() && record.chain === chainName) }
      : undefined;
  }
}
