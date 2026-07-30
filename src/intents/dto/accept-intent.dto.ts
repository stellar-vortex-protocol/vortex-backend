import { IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AcceptIntentDto {
  @ApiProperty({ description: "Solver address accepting the intent" })
  @IsString()
  @MinLength(5)
  solver!: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "accept:<intentId>:<solver>" ' +
      "produced by the solver's private key",
  })
  @IsString()
  @MinLength(10)
  signature!: string;
}
