import { Inject, Injectable, Optional } from "@nestjs/common";
import { Route, RouteStep, TokenInfo } from "../intents/intents.types";

/**
 * Options passed into buildRoute() from the caller (IntentsController.quote()).
 * Keeping these external ensures RoutingService stays pure/stateless — it never
 * calls TokensService or SolversService directly, making it easy to unit-test.
 */
export interface RouteOptions {
  /** Total fees in USD already computed by the quote engine. */
  totalFeesUSD: number;
  /** Price impact already computed by the quote engine (decimal fraction). */
  priceImpact: number;
  /** Estimated fill time in seconds (solver avg + jitter). */
  estimatedFillTime: number;
}

/**
 * A candidate intermediate (bridge) token for two-hop routes.
 */
export interface IntermediateToken {
  symbol: string;
  address: string;
  decimals: number;
  /** Human-readable name; defaults to the symbol when omitted. */
  name?: string;
}

/**
 * Per-chain ordered list of candidate intermediate tokens. The router picks the
 * first viable candidate for the source chain. Chains with no entry fall back
 * to the hardcoded USDC behavior.
 */
export type IntermediateTokenConfig = Partial<Record<string, IntermediateToken[]>>;

/**
 * DI token for the configurable intermediate bridge-token list. Provided by
 * RoutingModule so RoutingService stays a pure, stateless, easily-testable
 * class (see issue #220 implementation guidelines).
 */
export const INTERMEDIATE_TOKENS = Symbol("INTERMEDIATE_TOKENS");

/**
 * USDC contract addresses used as the intermediate token for two-hop routes.
 * When the source token is neither USDC nor a well-known stable, the router
 * goes: srcToken → USDC (bridge/swap) → dstToken (Stellar bridge).
 */
const USDC_ADDRESSES: Partial<Record<string, string>> = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  stellar: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};

const USDC_SYMBOL = "USDC";
const USDC_DECIMALS_EVM = 6;
const USDC_DECIMALS_STELLAR = 7;

/**
 * Default intermediate-token config: USDC-only, matching the historical
 * hardcoded behavior exactly.
 */
export const DEFAULT_INTERMEDIATE_TOKENS: IntermediateTokenConfig = Object.fromEntries(
  Object.entries(USDC_ADDRESSES).map(([chain, address]) => [
    chain,
    [
      {
        symbol: USDC_SYMBOL,
        address: address as string,
        decimals: chain === "stellar" ? USDC_DECIMALS_STELLAR : USDC_DECIMALS_EVM,
        name: "USD Coin",
      },
    ],
  ]),
);

@Injectable()
export class RoutingService {
  constructor(
    @Optional()
    @Inject(INTERMEDIATE_TOKENS)
    private readonly intermediateTokens: IntermediateTokenConfig = DEFAULT_INTERMEDIATE_TOKENS,
  ) {}

  /**
   * Build the optimal route for a cross-chain swap.
   *
   * Strategy:
   * 1. **Direct route** — when srcToken and dstToken share the same base asset
   *    (e.g. USDC→USDC), or when a direct solver path is viable, use a single
   *    "transfer" step via the solver.
   * 2. **Two-hop route** — when the source token is not USDC (or another
   *    well-known stable) a two-hop path is used:
   *      step 1: swap/bridge srcToken → intermediate on the source chain
   *      step 2: bridge intermediate → dstToken on Stellar
   *
   * Fee and price-impact figures are passed in from the caller so this service
   * stays stateless and free of cross-module dependencies (see issue #220
   * implementation guidelines).
   */
  buildRoute(
    srcToken: TokenInfo,
    dstToken: TokenInfo,
    solver: string,
    opts: RouteOptions,
  ): Route {
    const isDirect = this.canUseDirect(srcToken, dstToken);
    if (isDirect) {
      return this.createDirectRoute(srcToken, dstToken, solver, opts);
    }
    return this.createTwoHopRoute(srcToken, dstToken, solver, opts);
  }

  /**
   * A direct solver route: one bridge/transfer step from srcChain → Stellar.
   * Used when srcToken and dstToken are the same asset (e.g. USDC→USDC) or
   * when the solver can handle the pair natively.
   */
  createDirectRoute(
    srcToken: TokenInfo,
    dstToken: TokenInfo,
    solver: string,
    opts?: RouteOptions,
  ): Route {
    const step: RouteStep = {
      type: "transfer",
      protocol: "direct-solver",
      fromChain: srcToken.chain,
      toChain: "stellar",
      fromToken: srcToken,
      toToken: dstToken,
      estimatedTime: opts?.estimatedFillTime ?? 60,
      estimatedGas: "0",
    };

    return {
      steps: [step],
      totalTime: step.estimatedTime,
      totalFeesUSD: opts?.totalFeesUSD ?? 0,
      priceImpact: opts?.priceImpact ?? 0,
    };
  }

  /**
   * Two-hop route: srcToken → intermediate (on source chain) → dstToken (on Stellar).
   *
   * Used when the source token is not directly bridgeable by a solver
   * (e.g. WETH → USDC → yXLM). The intermediate token is selected from the
   * configured per-chain candidate list (first viable candidate), falling back
   * to USDC when no candidates are configured for the source chain.
   */
  createTwoHopRoute(
    srcToken: TokenInfo,
    dstToken: TokenInfo,
    solver: string,
    opts?: RouteOptions,
  ): Route {
    const intermediate = this.selectIntermediate(srcToken);

    // Step 1: swap/bridge srcToken → intermediate on source chain
    const step1: RouteStep = {
      type: "swap",
      protocol: "uniswap-v3",
      fromChain: srcToken.chain,
      toChain: srcToken.chain,
      fromToken: srcToken,
      toToken: intermediate,
      estimatedTime: 15,
      estimatedGas: "21000",
    };

    // Step 2: bridge intermediate → Stellar dstToken
    const step2: RouteStep = {
      type: "bridge",
      protocol: "direct-solver",
      fromChain: srcToken.chain,
      toChain: "stellar",
      fromToken: intermediate,
      toToken: dstToken,
      estimatedTime: opts?.estimatedFillTime ?? 60,
      estimatedGas: "0",
    };

    const totalTime = step1.estimatedTime + step2.estimatedTime;

    return {
      steps: [step1, step2],
      totalTime,
      totalFeesUSD: opts?.totalFeesUSD ?? 0,
      priceImpact: opts?.priceImpact ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Select the first viable intermediate token for the source chain from the
   * configured candidate list. Falls back to the hardcoded USDC behavior when
   * the chain has no configured candidates (or none are viable).
   */
  private selectIntermediate(srcToken: TokenInfo): TokenInfo {
    const candidates = this.intermediateTokens?.[srcToken.chain] ?? [];
    const viable = candidates.find(
      (c) => c.address && c.symbol && c.symbol.toUpperCase() !== srcToken.symbol.toUpperCase(),
    );
    if (viable) {
      return {
        address: viable.address,
        symbol: viable.symbol,
        name: viable.name ?? viable.symbol,
        decimals: viable.decimals,
        chain: srcToken.chain,
      };
    }
    return this.defaultUsdcIntermediate(srcToken.chain);
  }

  /**
   * Historical USDC-only intermediate, used as the fallback when no other
   * candidates are configured for a chain.
   */
  private defaultUsdcIntermediate(chain: string): TokenInfo {
    return {
      address: USDC_ADDRESSES[chain] ?? "",
      symbol: USDC_SYMBOL,
      name: "USD Coin",
      decimals: chain === "stellar" ? USDC_DECIMALS_STELLAR : USDC_DECIMALS_EVM,
      chain,
    };
  }

  /**
   * Returns true when the src/dst token pair can be handled with a single
   * direct solver step (same symbol, or both USDC variants).
   */
  private canUseDirect(srcToken: TokenInfo, dstToken: TokenInfo): boolean {
    // Same symbol (e.g. USDC → USDC, XLM → XLM)
    if (srcToken.symbol === dstToken.symbol) return true;
    // Both are USDC (different chain representations)
    if (
      srcToken.symbol.toUpperCase() === USDC_SYMBOL &&
      dstToken.symbol.toUpperCase() === USDC_SYMBOL
    ) {
      return true;
    }
    return false;
  }
}
