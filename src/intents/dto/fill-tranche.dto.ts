import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

/** Body of `POST /intents/:id/reservations/:fillId/fill` (issue #427). */
export class FillTrancheDto {
  @ApiProperty({ description: "Solver that holds the reservation", maxLength: 56 })
  @IsString()
  @MinLength(5)
  @MaxLength(56)
  solver!: string;

  @ApiProperty({
    description:
      "Destination-token base units delivered for this tranche. Must be ≥ the tranche's pro-rata " +
      "minDstAmount (minDstAmount × reservedAmount ÷ srcAmount, rounded up).",
  })
  @IsString()
  @Matches(/^\d+$/)
  @MaxLength(78)
  dstAmount!: string;

  @ApiPropertyOptional({ description: "Stellar delivery transaction hash", maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  txHash?: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of "fill-tranche:<intentId>:<fillId>:<solver>:<dstAmount>"',
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}
