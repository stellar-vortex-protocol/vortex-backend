import { IsIn, IsNotEmpty, IsString, Matches } from "class-validator";
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

export class QuoteRequestDto {
  @IsIn(SUPPORTED_CHAINS)
  srcChain!: SupportedChain;

  @IsString()
  @IsNotEmpty()
  srcTokenSymbol!: string;

  @IsString()
  @Matches(/^\d+$/)
  srcAmount!: string;

  @IsString()
  @IsNotEmpty()
  dstTokenSymbol!: string;
}
