import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class AcceptIntentDto {
  @ApiProperty({ description: "Solver address accepting the intent", maxLength: 56 })
  @IsString()
  @MinLength(5)
  @MaxLength(56)
  solver!: string;

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
