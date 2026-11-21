import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { ApiTags, ApiOkResponse, ApiQuery, ApiParam } from "@nestjs/swagger";
import type { Response } from "express";
import { TokensService } from "./tokens.service";
import { StellarTokensResponseDto } from "./dto/token-response.dto";

const SUPPORTED_VS_CURRENCIES = ["usd", "eur", "btc"] as const;

type VsCurrency = (typeof SUPPORTED_VS_CURRENCIES)[number];

function parseVsCurrency(raw?: string): VsCurrency {
  if (raw === undefined || raw === "") {
    return "usd";
  }
  const normalized = raw.toLowerCase();
  if (!(SUPPORTED_VS_CURRENCIES as readonly string[]).includes(normalized)) {
    throw new BadRequestException({
      message: `Unsupported vsCurrency '${raw}'. Supported values: ${SUPPORTED_VS_CURRENCIES.join(
        ", ",
      )}.`,
      supported: [...SUPPORTED_VS_CURRENCIES],
    });
  }
  return normalized as VsCurrency;
}

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
  @ApiQuery({
    name: "vsCurrency",
    required: false,
    enum: SUPPORTED_VS_CURRENCIES,
    description:
      "Quote currency for the `price` field. Supported: `usd` (default), `eur`, `btc`. " +
      "Prices are converted live against CoinGecko at request time; `priceUSD` is always " +
      "returned in USD regardless of this parameter.",
  })
  @ApiOkResponse({
    description:
      "Supported tokens. With `chain` set, `{ tokens: Token[], chain }`; without it, " +
      "`tokens` is keyed by chain and `stellarTokens` holds the Stellar list. Each token " +
      "carries `priceUSD` (always USD) plus `price` + `currency` in the requested `vsCurrency`.",
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
                  price: { type: "number", example: 0.92 },
                  currency: { type: "string", example: "eur" },
                },
                required: ["symbol", "name", "decimals", "priceUSD", "price", "currency"],
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
                    price: { type: "number", example: 0.92 },
                    currency: { type: "string", example: "eur" },
                  },
                  required: [
                    "address",
                    "symbol",
                    "name",
                    "decimals",
                    "priceUSD",
                    "price",
                    "currency",
                  ],
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
                  price: { type: "number", example: 0.0000019 },
                  currency: { type: "string", example: "btc" },
                },
                required: [
                  "contract",
                  "symbol",
                  "name",
                  "decimals",
                  "priceUSD",
                  "price",
                  "currency",
                ],
              },
            },
          },
          required: ["tokens", "stellarTokens"],
        },
      ],
    },
  })
  getTokens(@Query("chain") chain?: string, @Query("vsCurrency") vsCurrency?: string) {
    return this.tokensService.getByChain(chain, parseVsCurrency(vsCurrency));
  }

  @Get("stellar")
  @ApiQuery({
    name: "vsCurrency",
    required: false,
    enum: SUPPORTED_VS_CURRENCIES,
    description:
      "Quote currency for the `price` field. Supported: `usd` (default), `eur`, `btc`. " +
      "Prices are converted live against CoinGecko at request time; `priceUSD` is always " +
      "returned in USD regardless of this parameter.",
  })
  @ApiOkResponse({
    type: StellarTokensResponseDto,
    description:
      "The full list of supported Stellar destination tokens. Each token carries " +
      "`priceUSD` (always USD) plus `price` + `currency` in the requested `vsCurrency`.",
  })
  getStellarTokens(@Query("vsCurrency") vsCurrency?: string) {
    return this.tokensService.getStellarTokens(parseVsCurrency(vsCurrency));
  }

  @Get(":address/logo")
  @ApiParam({
    name: "address",
    description: "Token contract address whose verified logo should be served.",
  })
  @ApiQuery({
    name: "chain",
    required: false,
    description: "Chain the token belongs to (defaults to `stellar`).",
  })
  @ApiOkResponse({
    description:
      "The verified token logo bytes, proxied and cached server-side so clients never " +
      "hotlink the original admin-supplied host. Content-Type reflects the verified image type.",
    schema: { type: "string", format: "binary" },
  })
  async getTokenLogo(
    @Param("address") address: string,
    @Res({ passthrough: true }) res: Response,
    @Query("chain") chain?: string,
  ) {
    const logo = await this.tokensService.getTokenLogo(address, chain);
    if (!logo) {
      throw new NotFoundException(`No verified logo available for token '${address}'.`);
    }
    res.setHeader("Content-Type", logo.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return logo.body;
  }
}
