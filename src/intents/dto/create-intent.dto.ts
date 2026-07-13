import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from "class-validator";
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
  @IsString()
  @MinLength(10)
  user!: string;

  @IsIn(SUPPORTED_CHAINS)
  srcChain!: SupportedChain;

  @IsString()
  @MinLength(10)
  srcTokenAddress!: string;

  @IsString()
  srcTokenSymbol!: string;

  @IsInt()
  @Min(0)
  @Max(18)
  srcTokenDecimals!: number;

  @IsString()
  @Matches(/^\d+$/)
  srcAmount!: string;

  @IsString()
  @MinLength(10)
  dstTokenContract!: string;

  @IsString()
  dstTokenSymbol!: string;

  @IsInt()
  @Min(0)
  @Max(18)
  dstTokenDecimals!: number;

  @IsString()
  @Matches(/^\d+$/)
  minDstAmount!: string;

  @IsOptional()
  @IsInt()
  deadline?: number;
}
