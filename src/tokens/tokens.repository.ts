import { SupportedChain } from "../intents/intents.types";

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
}

export const TOKENS_REPOSITORY = Symbol("TOKENS_REPOSITORY");

export interface ITokensRepository {
  findAll(): Promise<TokenRecord[]> | TokenRecord[];
  findByChain(chain: SupportedChain | string): Promise<TokenRecord[]> | TokenRecord[];
  findByAddressAndChain(
    address: string,
    chain: SupportedChain | string,
  ): Promise<TokenRecord | undefined> | TokenRecord | undefined;
}
