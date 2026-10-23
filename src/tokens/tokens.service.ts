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

export interface ApiToken {
  address: string;
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number;
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
    srcToken: string,
    dstToken: string,
  ): Promise<PairOracleOverride | undefined> {
    const key = normalizePairKey(srcToken, dstToken);
    const overrides = await this.loadPairOracleOverrides();
    return overrides.get(key);
  }

  /**
   * Build the full `pairOverrides` lookup keyed by normalised `srcToken:dstToken`.
   *
   * Reads the registry once and projects any per-pair oracle bound columns into
   * a `Map`. Pairs without an override are omitted entirely so a lookup miss is
   * an unambiguous "use the global default" signal.
   */
  async loadPairOracleOverrides(): Promise<Map<string, PairOracleOverride>> {
    const records = await this.repo.findAll();
    const overrides = new Map<string, PairOracleOverride>();
    for (const record of records) {
      const slippage = record.oracleMaxUserSlippageBps;
      const premium = record.oracleMaxPremiumBps;
      if (slippage == null && premium == null) continue;
      const dstToken = record.oracleOverrideDstToken;
      if (!dstToken) continue;
      const override: PairOracleOverride = {};
      if (slippage != null) override.maxUserSlippageBps = BigInt(slippage);
      if (premium != null) override.maxPremiumBps = BigInt(premium);
      overrides.set(normalizePairKey(record.address, dstToken), override);
    }
    return overrides;
  }

  /**
   * Normalise a stored {@link TokenRecord} into the public token shape.
   *
   * Both `address` and `contract` are emitted with the same value so clients
   * can read either field regardless of whether the token is EVM- or
   * Stellar-native — the registry stores every token under `address`, but the
   * Stellar side of the API has always used `contract`.
   */
  private toApiToken(record: TokenRecord): ApiToken {
    return {
      address: record.address,
      contract: record.address,
      symbol: record.symbol,
      name: record.name,
      decimals: record.decimals,
      priceUSD: record.priceUsd ?? 0,
    };
  }

  /**
   * Delisted entries disappear from the registry listing — they stay
   * resolvable for intents created before the delist (see
   * {@link resolveSrcToken}), but must not appear in discovery results.
   * Paused tokens remain visible: under review, not retired.
   */
  private hideDelisted<T extends { status?: TokenStatus }>(records: T[]): T[] {
    return records.filter((record) => (record.status ?? "active") !== "delisted");
  }

  /**
   * Return the supported token registry, optionally narrowed to one chain.
   *
   * - `chain="stellar"` → `{ tokens: StellarToken[], chain: "stellar" }`
   * - `chain=<known>`   → `{ tokens: Token[], chain }`
   * - omitted / unknown → `{ tokens: Record<chain, Token[]>, stellarTokens: Token[] }`
   *
   * An unrecognised chain deliberately falls back to the full registry rather
   * than erroring: this endpoint feeds discovery UIs, and a client with a
   * stale chain list should see everything, not a 4xx.
   */
  async getByChain(chain?: string): Promise<TokensByChainResponse> {
    const requested = chain?.toLowerCase();

    if (requested === "stellar") {
      const records = this.hideDelisted(await this.findByChain("stellar"));
      return {
        tokens: records.map((record) => this.toApiToken(record)),
        chain: "stellar",
      };
    }

    if (requested && requested in SUPPORTED_TOKENS) {
      const records = this.hideDelisted(await this.findByChain(requested));
      return {
        tokens: records
          .filter((record) => record.chain === requested)
          .map((record) => this.toApiToken(record)),
        chain: requested,
      };
    }

    const all = this.hideDelisted(await this.findAll());

    // Bucket by chain, pre-seeding a key for every chain the static registry
    // declares so a chain with no rows still appears as an empty array rather
    // than vanishing from the response shape.
    const byChain: Record<string, ApiToken[]> = {};
    for (const key of Object.keys(SUPPORTED_TOKENS)) {
      byChain[key] = [];
    }
    for (const record of all) {
      if (!byChain[record.chain]) byChain[record.chain] = [];
      byChain[record.chain].push(this.toApiToken(record));
    }

    return {
      tokens: byChain,
      stellarTokens: all
        .filter((record) => record.chain === "stellar")
        .map((record) => this.toApiToken(record)),
    };
  }

  async getStellarTokens(): Promise<{ tokens: StellarToken[] }> {
    const records = await this.findByChain("stellar");
    return {
      tokens: records.map((record) => ({
        contract: record.address,
        symbol: record.symbol,
        name: record.name,
        decimals: record.decimals,
        priceUSD: record.priceUsd ?? 0,
      })),
    };
  }
}
