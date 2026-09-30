import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CancelIntentDto {
  @ApiProperty({ description: "Stellar or EVM address of the intent's original creator (must match)", maxLength: 56 })
  @IsString()
  @MinLength(10)
  @MaxLength(56)
  user!: string;

  @ApiPropertyOptional({ description: "Single-use signing nonce", minLength: 16, maxLength: 128 })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,128}$/)
  nonce?: string;

  @ApiPropertyOptional({ description: "Unix timestamp when the signature expires" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4102444800)
  expiresAt?: number;

  @ApiProperty({ description: "Base64 Ed25519 or EIP-712 signature proving control of user", maxLength: 4096 })
  @IsString()
  @Matches(/^(?:[A-Za-z0-9+/]{4,}={0,2}|0x(?:[0-9a-fA-F]{2})+)$/)
  @MaxLength(4096)
  signature!: string;
}
