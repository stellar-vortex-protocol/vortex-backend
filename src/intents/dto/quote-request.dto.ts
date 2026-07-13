import { IsIn, IsNotEmpty, IsString, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
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
  @ApiProperty({ enum: SUPPORTED_CHAINS, description: "Source chain the funds are coming from" })
  @IsIn(SUPPORTED_CHAINS)
  srcChain!: SupportedChain;

  @ApiProperty({ description: "Source token symbol, e.g. USDC" })
  @IsString()
  @IsNotEmpty()
  srcTokenSymbol!: string;

  @ApiProperty({ description: "Source amount as a non-negative integer string" })
  @IsString()
  @Matches(/^\d+$/)
  srcAmount!: string;

  @ApiProperty({ description: "Destination token symbol, e.g. USDC" })
  @IsString()
  @IsNotEmpty()
  dstTokenSymbol!: string;
}
