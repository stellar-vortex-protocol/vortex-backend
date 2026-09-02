import { IsIn, IsInt, IsNotEmpty, IsString, MinLength, Min, IsArray, ArrayMaxSize, MaxLength } from "class-validator";
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
  @ApiProperty({ description: "Solver's Stellar address", maxLength: 56 })
  @IsString()
  @MinLength(10)
  @MaxLength(56)
  address!: string;

  @ApiProperty({ description: "Solver's display name", maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
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
  @ArrayMaxSize(8)
  @IsIn(SUPPORTED_CHAINS, { each: true })
  supportedChains!: SupportedChain[];

  @ApiProperty({ isArray: true, description: "Token symbols this solver supports" })
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(16, { each: true })
  supportedTokens!: string[];

  @ApiProperty({ description: "Proof-of-control signature for the advertised solver address", maxLength: 88 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(88)
  proofSignature!: string;
}
