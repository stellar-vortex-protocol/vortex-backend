import { BadRequestException, Inject, Injectable } from "@nestjs/common";
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

@Injectable()
export class TokensService {
  constructor(
    @Inject(TOKENS_REPOSITORY)
    private readonly repo: ITokensRepository,
  ) {}

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
    const token = await this.repo.findByAddressAndChain(address, chain);
    if (!token) return undefined;
    return this.toResolvedSrcToken(token, chain);
  }

  /**
   * Look up a Stellar destination token by contract ID.
   *
   * Returns `undefined` when no match is found.
   */
  async resolveDstToken(contract: string): Promise<ResolvedDstToken | undefined> {
    const token = await this.repo.findByAddressAndChain(contract, "stellar");
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
    const record = await this.repo.findByAddressAndChain(address, chain);
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
      const records = this.hideDelisted(await this.repo.findByChain("stellar"));
      return {
        tokens: records.map((record) => this.toApiToken(record)),
        chain: "stellar",
      };
    }

    if (requested && requested in SUPPORTED_TOKENS) {
      const records = this.hideDelisted(await this.repo.findByChain(requested));
      return {
        tokens: records
          .filter((record) => record.chain === requested)
          .map((record) => this.toApiToken(record)),
        chain: requested,
      };
    }

    const all = this.hideDelisted(await this.repo.findAll());

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
    const records = await this.repo.findByChain("stellar");
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
