import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class CancelIntentDto {
  @ApiProperty({ description: "Stellar address of the intent's original creator (must match)", maxLength: 56 })
  @IsValidAddress({ chain: "stellar", message: "user must be a valid Stellar address (56-char G…)" })
  user!: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "cancel:<intentId>" ' +
      "produced by the private key of `user`",
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}
