import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { PENDING_SLASH_STATES, PendingSlashState } from "../../solvers/pending-slashes.repository";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class ListSlashesDto {
  @ApiPropertyOptional({ enum: PENDING_SLASH_STATES })
  @IsOptional()
  @IsIn(PENDING_SLASH_STATES)
  state?: PendingSlashState;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AdminCancelSlashDto {
  @ApiProperty({ description: "Why the slash is being cancelled (audit log)", maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  note!: string;
}

export class FillProofDto {
  @ApiProperty({ description: "Stellar address of the slashed solver", maxLength: 56 })
  @IsString()
  @MinLength(10)
  @MaxLength(56)
  solver!: string;

  @ApiProperty({ description: "Hash of the Stellar transaction that filled the intent (64 hex chars)" })
  @Matches(/^[0-9a-f]{64}$/i)
  txHash!: string;

  @ApiProperty({
    description:
      'Base64 Ed25519 signature by `solver` of "fill-proof:<intentId>:<solver>:<txHash>" ' +
      "(txHash lowercased)",
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}
