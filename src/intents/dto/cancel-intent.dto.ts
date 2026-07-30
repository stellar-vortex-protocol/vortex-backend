import { IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CancelIntentDto {
  @ApiProperty({ description: "Stellar address of the intent's original creator (must match)" })
  @IsString()
  @MinLength(10)
  user!: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "cancel:<intentId>" ' +
      "produced by the private key of `user`",
  })
  @IsString()
  @MinLength(10)
  signature!: string;
}
