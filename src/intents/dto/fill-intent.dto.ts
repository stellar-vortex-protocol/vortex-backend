import { IsOptional, IsString, Matches, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class FillIntentDto {
  @ApiProperty({ description: "Solver address filling the intent (must match the accepting solver)" })
  @IsString()
  @MinLength(5)
  solver!: string;

  @ApiProperty({ description: "Amount filled, as a non-negative integer string" })
  @IsString()
  @Matches(/^\d+$/)
  fillAmount!: string;

  @ApiPropertyOptional({ description: "Stellar fill transaction hash" })
  @IsOptional()
  @IsString()
  txHash?: string;

  @ApiProperty({
    description:
      'Base64-encoded Ed25519 signature of the message "fill:<intentId>:<solver>" ' +
      "produced by the solver's private key",
  })
  @IsString()
  @MinLength(10)
  signature!: string;
}
