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
  findAll(): TokenRecord[];
  findByChain(chain: SupportedChain | string): TokenRecord[];
  findByAddressAndChain(address: string, chain: SupportedChain | string): TokenRecord | undefined;
}
