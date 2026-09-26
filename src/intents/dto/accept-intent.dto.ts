import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class AcceptIntentDto {
  @ApiProperty({ description: "Solver Stellar address accepting the intent", maxLength: 56 })
  @IsValidAddress({ chain: "stellar", message: "solver must be a valid Stellar address (56-char G…)" })
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
