import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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
  @ApiProperty({ description: "Stellar G-address of the solver" })
  @IsString()
  @MinLength(10)
  address!: string;

  @ApiProperty({ description: "Human-readable solver name" })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ description: "Bond amount as a non-negative integer string (base units)" })
  @IsString()
  @Matches(/^\d+$/)
  bondAmount!: string;

  @ApiPropertyOptional({ default: false, description: "Whether the solver is immediately active" })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ enum: SUPPORTED_CHAINS, isArray: true, description: "Chains the solver supports" })
  @IsArray()
  @IsIn(SUPPORTED_CHAINS, { each: true })
  supportedChains!: SupportedChain[];

  @ApiProperty({ isArray: true, description: "Token symbols the solver supports" })
  @IsArray()
  @IsString({ each: true })
  supportedTokens!: string[];

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "register:<address>" ' +
      "produced by the solver's private key — proves key ownership",
  })
  @IsString()
  @MinLength(10)
  signature!: string;
}
