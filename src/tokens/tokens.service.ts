import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { SUPPORTED_TOKENS, StellarToken } from "./tokens.data";
import { SupportedChain } from "../intents/intents.types";
import { ITokensRepository, TOKENS_REPOSITORY, TokenRecord, TokenStatus } from "./tokens.repository";

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
  riskFlags?: string[];
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
  riskFlags?: string[];
}

export type ResolvedToken = ResolvedSrcToken | ResolvedDstToken;

export interface ApiToken {
  address: string;
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number;
  riskFlags: string[];
}

export interface TokensByChainResponse {
  tokens: ApiToken[] | Record<string, ApiToken[]>;
  chain?: string;
  stellarTokens?: ApiToken[];
}

/**
 * Token registry reads are near-static, so they are cached for minutes and
 * dropped on every registry write or price refresh (issue #414).
 */
const TOKENS_CACHE_TTL_SECONDS = 300;

/**
 * Per-token-pair oracle bound override (issue #634).
 *
 * Both fields are optional: a pair may widen only the slippage band, only the
 * premium band, or both. Unset fields fall back to the global
 * `OracleMinDstConfig` defaults at resolution time.
 */
export interface PairOracleOverride {
  maxUserSlippageBps?: bigint;
  maxPremiumBps?: bigint;
}

/**
 * Normalise a `srcToken:dstToken` pair key so lookups are case-insensitive and
 * whitespace-tolerant regardless of how the operator configured the override.
 */
export function normalizePairKey(srcToken: string, dstToken: string): string {
  return `${srcToken.trim().toLowerCase()}:${dstToken.trim().toLowerCase()}`;
}

@Injectable()
export class TokensService {
  constructor(
    @Inject(TOKENS_REPOSITORY)
    private readonly repo: ITokensRepository,
    /** Read cache (issue #414). Optional so unit harnesses can omit it. */
    @Optional() private readonly cache?: CacheService,
  ) {}

  /** Cache-aside wrapper over the registry; falls through when no cache is wired. */
  private cached<T>(key: string, load: () => Promise<T> | T): Promise<T> {
    if (!this.cache) return Promise.resolve(load());
    return this.cache.getOrLoad("tokens", key, TOKENS_CACHE_TTL_SECONDS, async () => load());
  }

  private findRecord(address: string, chain: string): Promise<TokenRecord | undefined> {
    // Key on the exact address: the repository decides case sensitivity, and
    // folding case here could serve one spelling's miss for another's hit.
    return this.cached(`record:${chain}:${address}`, () =>
      this.repo.findByAddressAndChain(address, chain),
    );
  }

  private findByChain(chain: string): Promise<TokenRecord[]> {
    return this.cached(`chain:${chain}`, () => this.repo.findByChain(chain));
  }

  private findAll(): Promise<TokenRecord[]> {
    return this.cached("all", () => this.repo.findAll());
  }

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
  async resolveSrcToken(chain: SupportedChain, address: string): Promise<ResolvedSrcToken | undefined> {
    const token = await this.findRecord(address, chain);
    if (!token) return undefined;
    return this.toResolvedSrcToken(token, chain);
  }

  /**
   * Look up a Stellar destination token by contract ID.
   *
   * Returns `undefined` when no match is found.
   */
  async resolveDstToken(contract: string): Promise<ResolvedDstToken | undefined> {
    const token = await this.findRecord(contract, "stellar");
    if (!token) return undefined;
    return {
      kind: "dst",
      contract: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      priceUSD: token.priceUsd ?? 0,
      riskFlags: token.riskFlags ?? [],
    };
  }

  /**
   * Like {@link resolveSrcToken} but throws a `BadRequestException` instead of
   * returning `undefined` when the chain + address does not resolve to a token
   * in the configured registry (issue #276).
   *
   * Also rejects paused and delisted tokens: this sits on the write path
   * (intent creation, quoting), where a token that admins have taken out of
   * rotation must not spawn new activity. Deliberately *not* used on the
   * fill/settlement path — an already-created intent keeps working against
   * its copied srcToken after its registry entry is delisted.
   */
  async resolveSrcTokenOrThrow(
    chain: SupportedChain,
    address: string,
  ): Promise<ResolvedSrcToken> {
    const record = await this.findRecord(address, chain);
    if (!record) {
      throw new BadRequestException(
        `Unknown source token '${address}' for chain '${chain}' in the configured token registry`,
      );
    }
    const status = record.status ?? "active";
    if (status !== "active") {
      throw new BadRequestException(
        `Source token '${address}' for chain '${chain}' is ${status}; ${status} tokens cannot be used for new intents or quotes`,
      );
    }
    return this.toResolvedSrcToken(record, chain);
  }

  /** Normalise a stored source-chain token record into the public shape. */
  private toResolvedSrcToken(token: TokenRecord, chain: SupportedChain): ResolvedSrcToken {
    return {
      kind: "src",
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      chain,
      priceUSD: token.priceUsd ?? 0,
      riskFlags: token.riskFlags ?? [],
    };
  }

  /**
   * Project a resolved token into the public `ApiToken` shape used by the
   * registry endpoints (issue #655 reuses this for watchlist resolution).
   *
   * `riskFlags` is always present (empty array when unset) so clients can
   * render a warning badge without defensive null checks (issue #656).
   */
  toApiToken(token: ResolvedToken): ApiToken {
    if (token.kind === "dst") {
      return {
        address: token.contract,
        contract: token.contract,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        priceUSD: token.priceUSD,
        riskFlags: token.riskFlags ?? [],
      };
    }
    return {
      address: token.address,
      contract: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      priceUSD: token.priceUSD,
      riskFlags: token.riskFlags ?? [],
    };
  }

  /**
   * Like {@link resolveDstToken} but throws a `BadRequestException` instead of
   * returning `undefined` when the contract does not resolve to a known Stellar
   * token (issue #276).
   */
  async resolveDstTokenOrThrow(contract: string): Promise<ResolvedDstToken> {
    const token = await this.resolveDstToken(contract);
    if (!token) {
      throw new BadRequestException(
        "Unknown destination token contract for the configured token registry",
      );
    }
    return token;
  }

  /**
   * Resolve the per-pair oracle bound override for a `srcToken:dstToken` pair
   * (issue #634).
   *
   * Overrides are sourced from the token registry: the source token's
   * `oracleMaxUserSlippageBps`/`oracleMaxPremiumBps` columns (when present on
   * the record) are keyed by the normalised pair. Returns `undefined` when no
   * override is configured for the pair, letting callers fall back to the
   * global `OracleMinDstConfig` defaults.
   *
   * Partial overrides are preserved as-is: only the fields the operator set are
   * populated, so the caller can fall back per-field rather than per-pair.
   */
  async resolvePairOracleOverride(
