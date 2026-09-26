import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class FillIntentDto {
  @ApiProperty({ description: "Solver Stellar address filling the intent (must match the accepting solver)", maxLength: 56 })
  @IsValidAddress({ chain: "stellar", message: "solver must be a valid Stellar address (56-char G…)" })
  solver!: string;

  @ApiProperty({ description: "Amount filled, as a non-negative integer string" })
  @IsString()
  @Matches(/^\d+$/)
  fillAmount!: string;

  @ApiPropertyOptional({ description: "Stellar fill transaction hash", maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  txHash?: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "fill:<intentId>:<solver>" ' +
      "produced by the solver's private key",
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}
