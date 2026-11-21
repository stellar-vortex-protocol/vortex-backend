import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsOptional, IsString } from "class-validator";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";

export class QuoteRequestDto {
  @ApiProperty({ description: "Source chain", example: "stellar" })
  @IsString()
  srcChain!: string;

  @ApiProperty({ description: "Source token contract address" })
  @IsString()
  srcToken!: string;

  @ApiProperty({ description: "Destination chain", example: "stellar" })
  @IsString()
  dstChain!: string;

  @ApiProperty({ description: "Destination token contract address" })
  @IsString()
  dstToken!: string;

  @ApiProperty({ description: "Source amount in base units" })
  @IsString()
  srcAmount!: string;

  @ApiPropertyOptional({
    description:
      "Optional allowlist of trusted solver addresses. When present, quotes are solicited only from the intersection of eligible solvers and this list. Addresses that are not registered/active solvers are ignored. If the intersection is empty, no quotes are returned.",
    type: [String],
    maxItems: 10,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsValidAddress({ each: true })
  preferredSolvers?: string[];
}
