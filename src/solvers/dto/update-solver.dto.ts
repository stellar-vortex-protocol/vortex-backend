import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
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
 * Only `name`, `supportedChains`, `supportedTokens`, `avgFillTime`,
 * `avatarUrl`, `description` and `websiteUrl` may be changed. Immutable fields
 * (`address`, `bondAmount`, `fillsCompleted`, `fillsFailed`, `totalVolume`,
 * `registeredAt`, `isActive`) are not declared here, so the global
 * `ValidationPipe({ whitelist: true })` strips them from the request body
 * before this DTO is ever handed to the controller.
 *
 * `verified` is deliberately NOT declared here (issue #643): it is an
 * operator-only badge settable solely through the admin-gated endpoint, so a
 * compromised solver signature can never self-certify.
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

  @ApiPropertyOptional({
    description:
      "Link to an externally hosted avatar image (https:// only; images are not uploaded here)",
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false })
  @Matches(/^https:\/\//i, { message: "avatarUrl must use the https:// scheme" })
  avatarUrl?: string;

  @ApiPropertyOptional({
    description: "Plain-text public description of the solver (HTML is stripped)",
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: "Link to the solver's website (https:// only)",
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false })
  @Matches(/^https:\/\//i, { message: "websiteUrl must use the https:// scheme" })
  websiteUrl?: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "update-solver:<address>" ' +
      "produced by the solver's private key, proving control of :address",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(88)
  signature!: string;
}
