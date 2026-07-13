import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TokensService } from "./tokens.service";

@ApiTags("tokens")
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
