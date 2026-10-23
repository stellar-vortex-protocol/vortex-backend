import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

/** Body of `POST /intents/:id/reservations` (issue #427). */
export class ReserveTrancheDto {
  @ApiProperty({ description: "Solver address reserving the tranche", maxLength: 56 })
  @IsString()
  @MinLength(5)
  @MaxLength(56)
  solver!: string;

  @ApiProperty({
    description:
      "Source-token base units to reserve. Must be ≥ the intent's minFillAmount unless it takes the whole " +
      "unreserved remainder, and may not exceed that remainder.",
    example: "250000000",
  })
  @IsString()
  @Matches(/^[1-9]\d*$/)
  @MaxLength(78)
  amount!: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of "reserve:<intentId>:<solver>:<amount>" by the solver\'s key',
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}
