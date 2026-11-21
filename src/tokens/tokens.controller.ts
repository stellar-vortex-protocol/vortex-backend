import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiTags, ApiOkResponse, ApiQuery, ApiParam } from "@nestjs/swagger";
import { TokensService } from "./tokens.service";
import { StellarTokensResponseDto } from "./dto/token-response.dto";

@ApiTags("tokens")
@Controller({ path: "tokens", version: "1" })
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Get()
  @ApiQuery({
    name: "chain",
    required: false,
    description:
      "Restrict the result to a single chain (e.g. `stellar`, `ethereum`, `base`). " +
      "When omitted, every supported chain plus the Stellar token list is returned.",
  })
  @ApiOkResponse({
    description:
      "Supported tokens. With `chain` set, `{ tokens: Token[], chain }`; without it, " +
      "`tokens` is keyed by chain and `stellarTokens` holds the Stellar list.",
    schema: {
      oneOf: [
        {
          type: "object",
          properties: {
            tokens: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  address: { type: "string" },
                  contract: { type: "string" },
                  symbol: { type: "string", example: "USDC" },
                  name: { type: "string", example: "USD Coin" },
                  decimals: { type: "number", example: 6 },
                  priceUSD: { type: "number", example: 1 },
                },
                required: ["symbol", "name", "decimals", "priceUSD"],
              },
            },
            chain: { type: "string", example: "ethereum" },
          },
          required: ["tokens", "chain"],
        },
        {
          type: "object",
          properties: {
            tokens: {
              type: "object",
              additionalProperties: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    symbol: { type: "string", example: "USDC" },
                    name: { type: "string", example: "USD Coin" },
                    decimals: { type: "number", example: 6 },
                    priceUSD: { type: "number", example: 1 },
                  },
                  required: ["address", "symbol", "name", "decimals", "priceUSD"],
                },
              },
            },
            stellarTokens: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  contract: { type: "string" },
                  symbol: { type: "string", example: "XLM" },
                  name: { type: "string", example: "Stellar Lumens" },
                  decimals: { type: "number", example: 7 },
                  priceUSD: { type: "number", example: 0.1182 },
                },
                required: ["contract", "symbol", "name", "decimals", "priceUSD"],
              },
            },
          },
          required: ["tokens", "stellarTokens"],
        },
      ],
    },
  })
  getTokens(@Query("chain") chain?: string) {
    return this.tokensService.getByChain(chain);
  }

  @Get("stellar")
  @ApiOkResponse({
    type: StellarTokensResponseDto,
    description: "The full list of supported Stellar destination tokens.",
  })
  getStellarTokens() {
    return this.tokensService.getStellarTokens();
  }

  @Get(":symbol/price-history")
  @ApiParam({ name: "symbol", description: "Token symbol, e.g. `USDC`." })
  @ApiQuery({
    name: "from",
    required: false,
    description: "ISO-8601 lower bound (inclusive) on `recordedAt`.",
  })
  @ApiQuery({
    name: "to",
    required: false,
    description: "ISO-8601 upper bound (inclusive) on `recordedAt`.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Maximum number of points to return (default 500).",
  })
  @ApiOkResponse({
    description:
      "Recent price history for the token, ordered oldest-first. Returns an empty " +
      "`points` array when the token exists but has no history yet.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", example: "USDC" },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: {
              priceUsd: { type: "number", example: 1 },
              recordedAt: { type: "string", format: "date-time" },
            },
            required: ["priceUsd", "recordedAt"],
          },
        },
      },
      required: ["symbol", "points"],
    },
  })
  getPriceHistory(
    @Param("symbol") symbol: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    return this.tokensService.getPriceHistory(symbol, { from, to, limit });
  }
}
