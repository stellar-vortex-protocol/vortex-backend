import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  INTENT_STATES,
  IntentState,
  SUPPORTED_CHAINS,
  SupportedChain,
} from "../intents.types";
import { LIST_MAX_LIMIT } from "../../config/limits.config";

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

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIST_MAX_LIMIT,
    default: 20,
    description: `Number of results per page (max ${LIST_MAX_LIMIT})`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LIST_MAX_LIMIT)
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
