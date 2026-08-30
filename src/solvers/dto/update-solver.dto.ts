import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
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

/**
 * Partial update to a solver's *mutable* profile fields (issue #273).
 *
 * Only `name`, `supportedChains`, `supportedTokens` and `avgFillTime` may be
 * changed. Immutable fields (`address`, `bondAmount`, `fillsCompleted`,
 * `fillsFailed`, `totalVolume`, `registeredAt`, `isActive`) are not declared
 * here, so the global `ValidationPipe({ whitelist: true })` strips them from
 * the request body before this DTO is ever handed to the controller.
 */
export class UpdateSolverDto {
  @ApiPropertyOptional({ description: "New display name" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({
    enum: SUPPORTED_CHAINS,
    isArray: true,
    description: "Replacement list of chains this solver supports",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(SUPPORTED_CHAINS, { each: true })
  supportedChains?: SupportedChain[];

  @ApiPropertyOptional({ isArray: true, description: "Replacement list of supported token symbols" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  supportedTokens?: string[];

  @ApiPropertyOptional({ description: "Updated average fill time in seconds" })
  @IsOptional()
  @IsInt()
  @Min(0)
  avgFillTime?: number;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "update-solver:<address>" ' +
      "produced by the solver's private key, proving control of :address",
  })
  @IsString()
  @IsNotEmpty()
  signature!: string;
}
