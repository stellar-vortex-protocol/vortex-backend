import { BadRequestException, Injectable } from "@nestjs/common";
import { SUPPORTED_TOKENS, STELLAR_TOKENS, SourceToken, StellarToken } from "./tokens.data";
import { SupportedChain } from "../intents/intents.types";

/**
 * A resolved source-chain (EVM or Stellar source) token — always has a
 * canonical `address` field used by TokensService.resolveToken().
 */
export interface ResolvedSrcToken {
  kind: "src";
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  priceUSD: number;
}

/**
 * A resolved Stellar destination token.
 */
export interface ResolvedDstToken {
  kind: "dst";
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number;
}

export type ResolvedToken = ResolvedSrcToken | ResolvedDstToken;

@Injectable()
export class TokensService {
  /**
   * Look up a source token by chain + address/contract.
   *
   * For Stellar source tokens the `address` parameter is the contract ID.
   * For EVM chains it is the checksummed hex address.
   *
   * Returns `undefined` when no match is found — callers decide how to handle
   * the "unknown token" case (e.g. fall back to a default priceUSD).
   *
   * @param chain   The source chain (stellar | ethereum | base | …)
   * @param address Token contract/address string
   */
  resolveSrcToken(chain: SupportedChain, address: string): ResolvedSrcToken | undefined {
    if (chain === "stellar") {
      const token = STELLAR_TOKENS.find((t) => t.contract === address);
      if (!token) return undefined;
      return {
        kind: "src",
        address: token.contract,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        chain,
        priceUSD: token.priceUSD,
      };
    }

    const chainTokens = SUPPORTED_TOKENS[chain];
    if (!chainTokens) return undefined;
    const token = chainTokens.find((t) => t.address === address);
    if (!token) return undefined;
    return {
      kind: "src",
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      chain,
      priceUSD: token.priceUSD,
    };
  }

  /**
   * Look up a Stellar destination token by contract ID.
   *
   * Returns `undefined` when no match is found.
   */
  resolveDstToken(contract: string): ResolvedDstToken | undefined {
    const token = STELLAR_TOKENS.find((t) => t.contract === contract);
    if (!token) return undefined;
    return {
      kind: "dst",
      contract: token.contract,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      priceUSD: token.priceUSD,
    };
  }

  /**
   * Like {@link resolveSrcToken} but throws a `BadRequestException` instead of
   * returning `undefined` when the chain + address does not resolve to a token
   * in the configured registry (issue #276).
   *
   * Use this on the write path (intent creation) where an unrecognised token
   * must be rejected outright rather than silently stored with no priceUSD.
   */
  resolveSrcTokenOrThrow(chain: SupportedChain, address: string): ResolvedSrcToken {
    const token = this.resolveSrcToken(chain, address);
    if (!token) {
      throw new BadRequestException(
        `Unknown source token '${address}' for chain '${chain}' in the configured token registry`,
      );
    }
    return token;
  }

  /**
   * Like {@link resolveDstToken} but throws a `BadRequestException` instead of
   * returning `undefined` when the contract does not resolve to a known Stellar
   * token (issue #276).
   */
  resolveDstTokenOrThrow(contract: string): ResolvedDstToken {
    const token = this.resolveDstToken(contract);
    if (!token) {
      throw new BadRequestException(
        "Unknown destination token contract for the configured token registry",
      );
    }
    return token;
  }

  getByChain(chain?: string) {
    if (chain === "stellar") {
      return { tokens: STELLAR_TOKENS.map((t) => ({ ...t })), chain: "stellar" };
    }
    if (chain && chain in SUPPORTED_TOKENS) {
      return { tokens: SUPPORTED_TOKENS[chain].map((t) => ({ ...t })), chain };
    }
    return {
      tokens: Object.fromEntries(
        Object.entries(SUPPORTED_TOKENS).map(([key, tokens]) => [key, tokens.map((t) => ({ ...t }))]),
      ),
      stellarTokens: STELLAR_TOKENS.map((t) => ({ ...t })),
    };
  }

  getStellarTokens(): { tokens: StellarToken[] } {
    return { tokens: STELLAR_TOKENS.map((t) => ({ ...t })) };
  }
}
