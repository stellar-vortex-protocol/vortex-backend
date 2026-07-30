import { Injectable } from "@nestjs/common";
import { SUPPORTED_TOKENS, STELLAR_TOKENS } from "./tokens.data";

@Injectable()
export class TokensService {
  getByChain(chain?: string) {
    if (chain === "stellar") {
      return { tokens: STELLAR_TOKENS.map(t => ({ ...t, priceUSD: t.priceUSD })), chain: "stellar" };
    }
    if (chain && chain in SUPPORTED_TOKENS) {
      return { tokens: SUPPORTED_TOKENS[chain].map(t => ({ ...t, priceUSD: t.priceUSD })), chain };
    }
    return { 
      tokens: Object.fromEntries(
        Object.entries(SUPPORTED_TOKENS).map(([key, tokens]) => 
          [key, tokens.map(t => ({ ...t, priceUSD: t.priceUSD }))]
        )
      ), 
      stellarTokens: STELLAR_TOKENS.map(t => ({ ...t, priceUSD: t.priceUSD })) 
    };
  }

  getStellarTokens() {
    return { tokens: STELLAR_TOKENS.map(t => ({ ...t, priceUSD: t.priceUSD })) };
  }
}
