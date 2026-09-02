import { ApiProperty } from "@nestjs/swagger";

/**
 * Swagger response shapes for `TokensController` (issue #271).
 *
 * These mirror the objects `TokensService` already returns — they add no new
 * fields and change no behaviour, they just give `/docs` a typed schema.
 */
export class StellarTokenDto {
  @ApiProperty({ description: "Stellar contract ID of the token" })
  contract!: string;

  @ApiProperty({ example: "XLM" })
  symbol!: string;

  @ApiProperty({ example: "Stellar Lumens" })
  name!: string;

  @ApiProperty({ example: 7 })
  decimals!: number;

  @ApiProperty({ example: 0.1182 })
  priceUSD!: number;
}

export class StellarTokensResponseDto {
  @ApiProperty({ type: [StellarTokenDto] })
  tokens!: StellarTokenDto[];
}
