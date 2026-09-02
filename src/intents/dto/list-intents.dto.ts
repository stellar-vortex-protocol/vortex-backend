import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  INTENT_STATES,
  IntentState,
  SUPPORTED_CHAINS,
  SupportedChain,
} from "../intents.types";

export class ListIntentsDto {
  @ApiPropertyOptional({
    description: "Filter by intent state",
    enum: INTENT_STATES,
  })
  @IsOptional()
  @IsIn(INTENT_STATES)
  state?: IntentState;

  @ApiPropertyOptional({ description: "Filter by user address" })
  @IsOptional()
  @IsString()
  user?: string;

  @ApiPropertyOptional({
    description: "Filter by source chain",
    enum: SUPPORTED_CHAINS,
  })
  @IsOptional()
  @IsIn(SUPPORTED_CHAINS)
  chain?: SupportedChain;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20, description: "Number of results per page" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: "Cursor for the next page of intents" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: "Number of results to skip" })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
