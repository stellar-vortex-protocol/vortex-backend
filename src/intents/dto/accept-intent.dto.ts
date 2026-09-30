import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class AcceptIntentDto {
  @ApiProperty({ description: "Solver address accepting the intent", maxLength: 56 })
  @IsString()
  @MinLength(5)
  @MaxLength(56)
  solver!: string;

  @ApiPropertyOptional({ description: "Single-use signing nonce", minLength: 16, maxLength: 128 })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/)
  nonce?: string;

  @ApiPropertyOptional({ description: "Unix timestamp when the signature expires" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4102444800)
  expiresAt?: number;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "accept:<intentId>:<solver>" ' +
      "produced by the solver's private key",
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}
