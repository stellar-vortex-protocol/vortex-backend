import { Injectable } from "@nestjs/common";
import { SUPPORTED_TOKENS, STELLAR_TOKENS } from "./tokens.data";

@Injectable()
export class TokensService {
  getByChain(chain?: string) {
    if (chain === "stellar") {
      return { tokens: STELLAR_TOKENS, chain: "stellar" };
    }
    if (chain && chain in SUPPORTED_TOKENS) {
      return { tokens: SUPPORTED_TOKENS[chain], chain };
    }
    return { tokens: SUPPORTED_TOKENS, stellarTokens: STELLAR_TOKENS };
  }

  getStellarTokens() {
    return { tokens: STELLAR_TOKENS };
  }
}
