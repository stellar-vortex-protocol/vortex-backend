import { Injectable } from "@nestjs/common";
import { TokensService } from "../tokens/tokens.service";
import { SupportedChain } from "../intents/intents.types";
import { PriceSnapshot, usdPriceToScale } from "./min-dst-amount.validation";

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
}
