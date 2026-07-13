import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SupportedChain } from "../intents.types";

const SUPPORTED_CHAINS: SupportedChain[] = [
  "stellar",
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
];

export class CreateIntentDto {
  @ApiProperty({ description: "Stellar address of the user creating the intent" })
  @IsString()
  @MinLength(10)
  user!: string;

  @ApiProperty({ enum: SUPPORTED_CHAINS, description: "Source chain the funds are coming from" })
  @IsIn(SUPPORTED_CHAINS)
  srcChain!: SupportedChain;

  @ApiProperty({ description: "Source token contract/address on srcChain" })
  @IsString()
  @MinLength(10)
  srcTokenAddress!: string;

  @ApiProperty({ description: "Source token symbol, e.g. USDC" })
  @IsString()
  srcTokenSymbol!: string;

  @ApiProperty({ minimum: 0, maximum: 18, description: "Source token decimals" })
  @IsInt()
  @Min(0)
  @Max(18)
  srcTokenDecimals!: number;

  @ApiProperty({ description: "Source amount as a non-negative integer string (base units)" })
  @IsString()
  @Matches(/^\d+$/)
  srcAmount!: string;

  @ApiProperty({ description: "Destination Stellar token contract" })
  @IsString()
  @MinLength(10)
  dstTokenContract!: string;

  @ApiProperty({ description: "Destination token symbol, e.g. USDC" })
  @IsString()
  dstTokenSymbol!: string;

  @ApiProperty({ minimum: 0, maximum: 18, description: "Destination token decimals" })
  @IsInt()
  @Min(0)
  @Max(18)
  dstTokenDecimals!: number;

  @ApiProperty({ description: "Minimum acceptable destination amount as an integer string" })
  @IsString()
  @Matches(/^\d+$/)
  minDstAmount!: string;

  @ApiPropertyOptional({ description: "Unix timestamp deadline; defaults to now + 1800s" })
  @IsOptional()
  @IsInt()
  deadline?: number;
}
