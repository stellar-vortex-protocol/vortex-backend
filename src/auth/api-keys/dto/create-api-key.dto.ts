import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { API_KEY_TIERS, ApiKeyTier } from "../api-key-tiers";

/** DTO for creating a new API key (issue #441). */
export class CreateApiKeyDto {
  @ApiProperty({
    enum: API_KEY_TIERS,
    description: "Rate-limit tier assigned to the key",
  })
  @IsIn(API_KEY_TIERS)
  tier!: ApiKeyTier;

  @ApiProperty({ description: "Free-text owner label (e.g. 'frontend', 'solver-bot-1')" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  owner!: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Optional scope strings narrowing what the key may do",
  })
  @IsOptional()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    description: "Unix epoch seconds at which the key expires (null = never)",
  })
  @IsOptional()
  @IsInt()
  expiresAt?: number;
}
