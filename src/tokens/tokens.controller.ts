import { Controller, Get, Query } from "@nestjs/common";
import { TokensService } from "./tokens.service";

@Controller("api/v1/tokens")
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Get()
  getTokens(@Query("chain") chain?: string) {
    return this.tokensService.getByChain(chain);
  }

  @Get("stellar")
  getStellarTokens() {
    return this.tokensService.getStellarTokens();
  }
}
