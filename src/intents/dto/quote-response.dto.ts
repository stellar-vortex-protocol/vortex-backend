import { ApiProperty } from "@nestjs/swagger";

export class QuoteDto {
  @ApiProperty({ description: "Solver address" })
  solver!: string;

  @ApiProperty({ description: "Solver name" })
  solverName!: string;

  @ApiProperty({ description: "Destination amount as a string" })
  dstAmount!: string;

  @ApiProperty({ description: "Protocol fee as a string" })
  fee!: string;

  @ApiProperty({ description: "Estimated fill time in seconds" })
  fillTime!: number;

  @ApiProperty({ description: "Unix timestamp when quote expires" })
  expiresAt!: number;

  @ApiProperty({ description: "Total fees in USD (protocol fee converted at token price)" })
  totalFeesUSD!: number;

  @ApiProperty({ description: "Estimated price impact as a decimal fraction, e.g. 0.003 = 0.3%" })
  priceImpact!: number;
}

export class QuoteResponseDto {
  @ApiProperty({ type: [QuoteDto], description: "Array of quotes sorted by best dstAmount first" })
  quotes!: QuoteDto[];

  @ApiProperty({ type: QuoteDto, nullable: true, description: "Best quote or null if no solvers available" })
  bestQuote!: QuoteDto | null;

  @ApiProperty({ description: "Source chain" })
  srcChain!: string;

  @ApiProperty({ description: "Source token symbol" })
  srcTokenSymbol!: string;

  @ApiProperty({ description: "Source amount as a string" })
  srcAmount!: string;

  @ApiProperty({ description: "Destination token symbol" })
  dstTokenSymbol!: string;

  @ApiProperty({ description: "Estimated fill time in seconds for the best quote" })
  estimatedFillTime!: number;

  @ApiProperty({ description: "Total fees in USD for the best quote (0 when no quote available)" })
  totalFeesUSD!: number;

  @ApiProperty({ description: "Price impact for the best quote as a decimal fraction (0 when no quote available)" })
  priceImpact!: number;
}
