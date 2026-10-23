import { Injectable } from "@nestjs/common";
import { TokensService } from "../tokens/tokens.service";
import { SupportedChain } from "../intents/intents.types";
import {
  OracleMinDstConfig,
  PriceSnapshot,
  usdPriceToScale,
} from "./min-dst-amount.validation";

/**
 * Per-token-pair override for the oracle slippage/premium bounds (issue #634).
 *
 * Either field may be omitted; omitted fields fall back to the global
 * {@link OracleMinDstConfig} defaults rather than zero/undefined.
 */
export interface PairOverride {
  maxUserSlippageBps?: bigint;
  maxPremiumBps?: bigint;
}

/**
 * Oracle aggregator (issue #434).
 *
 * Builds a {@link PriceSnapshot} from the token registry's last known USD
 * prices. Live feed adapters can replace {@link TokensService} lookups later
 * without changing {@link validateMinDstAmount}.
 */
@Injectable()
export class AggregatorService {
  constructor(private readonly tokens: TokensService) {}

  /**
   * Snapshot USD prices for a source token and a Stellar destination token.
   *
   * Missing registry entries or non-positive prices yield `null` sides so the
   * validator can apply fail-open / fail-closed policy.
   */
  async getPriceSnapshot(params: {
    srcChain: SupportedChain;
    srcTokenAddress: string;
    dstTokenContract: string;
    nowMs?: number;
  }): Promise<PriceSnapshot> {
    const src = await this.tokens.resolveSrcToken(params.srcChain, params.srcTokenAddress);
    const dst = await this.tokens.resolveDstToken(params.dstTokenContract);
    return {
      srcPriceUsd: src ? usdPriceToScale(src.priceUSD) : null,
      dstPriceUsd: dst ? usdPriceToScale(dst.priceUSD) : null,
      asOfMs: params.nowMs ?? Date.now(),
    };
  }

  /**
   * Read the current USD price for a single token (issue #637).
   *
   * Reuses the same registry lookup as {@link getPriceSnapshot} so price-alert
   * subscriptions do not introduce a second price-fetch path. Returns `null`
   * when the registry has no entry or a non-positive price for the token.
   */
  async getTokenPriceUsd(params: {
    chain: SupportedChain;
    tokenAddress: string;
  }): Promise<bigint | null> {
    const token = await this.tokens.resolveSrcToken(params.chain, params.tokenAddress);
    return token ? usdPriceToScale(token.priceUSD) : null;
  }

  /**
   * Normalize a token pair into the `srcToken:dstToken` lookup key.
   *
   * Source addresses are lowercased (EVM-style hex is case-insensitive) and
   * the Stellar destination contract is trimmed; both sides are trimmed of
   * surrounding whitespace so registry and request keys line up.
   */
  static pairKey(srcTokenAddress: string, dstTokenContract: string): string {
    return `${srcTokenAddress.trim().toLowerCase()}:${dstTokenContract.trim()}`;
  }

  /**
   * Resolve the effective {@link OracleMinDstConfig} for a token pair.
   *
   * Consults the per-pair override table first, then falls back to the global
   * defaults for any field the override does not set. This keeps
   * {@link validateMinDstAmount} a pure function: the caller resolves the
   * effective config before invoking it.
   */
  resolveMinDstConfig(params: {
    srcTokenAddress: string;
    dstTokenContract: string;
    globalConfig: OracleMinDstConfig;
    pairOverrides?: Map<string, PairOverride>;
  }): OracleMinDstConfig {
    const { globalConfig, pairOverrides } = params;
    if (!pairOverrides || pairOverrides.size === 0) {
      return globalConfig;
    }
    const override = pairOverrides.get(
      AggregatorService.pairKey(params.srcTokenAddress, params.dstTokenContract),
    );
    if (!override) {
      return globalConfig;
    }
    return {
      ...globalConfig,
      maxUserSlippageBps: override.maxUserSlippageBps ?? globalConfig.maxUserSlippageBps,
      maxPremiumBps: override.maxPremiumBps ?? globalConfig.maxPremiumBps,
    };
  }
}
