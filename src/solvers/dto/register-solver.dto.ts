import { IsIn, IsInt, IsNotEmpty, IsString, MinLength, Min, IsArray } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { SupportedChain } from "../../intents/intents.types";

const SUPPORTED_CHAINS: SupportedChain[] = [
  "stellar",
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
];

export class RegisterSolverDto {
  @ApiProperty({ description: "Solver's Stellar address" })
  @IsString()
  @MinLength(10)
  address!: string;

  @ApiProperty({ description: "Solver's display name" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ description: "Bond amount as a non-negative integer string (in USDC base units)" })
  @IsString()
  @IsNotEmpty()
  bondAmount!: string;

  @ApiProperty({ description: "Average fill time in seconds" })
  @IsInt()
  @Min(0)
  avgFillTime!: number;

  @ApiProperty({ enum: SUPPORTED_CHAINS, isArray: true, description: "Chains this solver supports" })
  @IsArray()
  @IsIn(SUPPORTED_CHAINS, { each: true })
  supportedChains!: SupportedChain[];

  @ApiProperty({ isArray: true, description: "Token symbols this solver supports" })
  @IsArray()
  @IsString({ each: true })
  supportedTokens!: string[];
}
