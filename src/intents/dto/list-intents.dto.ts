import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class ListIntentsDto {
  @ApiPropertyOptional({ description: "Filter by intent state" })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: "Filter by user address" })
  @IsOptional()
  @IsString()
  user?: string;

  @ApiPropertyOptional({ description: "Filter by source chain" })
  @IsOptional()
  @IsString()
  chain?: string;

  @ApiProperty({ minimum: 1, maximum: 100, default: 20, description: "Number of results per page" })
  @IsInt()
  @Min(1)
  @Max(100)
  limit!: number;

  @ApiProperty({ minimum: 0, default: 0, description: "Number of results to skip" })
  @IsInt()
  @Min(0)
  offset!: number;
}