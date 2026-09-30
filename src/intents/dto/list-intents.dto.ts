import { IsIn, IsInt, IsOptional, IsString, Max, Min, Matches } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  INTENT_STATES,
  IntentState,
  SUPPORTED_CHAINS,
  SupportedChain,
} from "../intents.types";
import { LIST_MAX_LIMIT } from "../../config/limits.config";

/**
 * Sort dimensions supported by `GET /intents` (issue #440).
 *
 * Each dimension accepts an optional `:asc` / `:desc` direction suffix.
 * The default is `created:desc` — identical to the pre-existing behaviour,
 * so omitting `sort` changes nothing.
 */
const SORT_PATTERN = /^(created|deadline|usd)(:(asc|desc))?$/;

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

  // ── Advanced filters (issue #440) ────────────────────────────────────────

  @ApiPropertyOptional({
    description: "Minimum USD value at creation (inclusive)",
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minAmountUsd?: number;

  @ApiPropertyOptional({
    description: "Maximum USD value at creation (inclusive)",
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxAmountUsd?: number;

  @ApiPropertyOptional({
    description: "Minimum creation time (unix epoch seconds, inclusive)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  createdFrom?: number;

  @ApiPropertyOptional({
    description: "Maximum creation time (unix epoch seconds, inclusive)",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  createdTo?: number;

  @ApiPropertyOptional({
    description: "Filter by source token symbol (case-insensitive)",
  })
  @IsOptional()
  @IsString()
  srcToken?: string;

  @ApiPropertyOptional({
    description: "Filter by destination token symbol (case-insensitive)",
  })
  @IsOptional()
  @IsString()
  dstToken?: string;

  @ApiPropertyOptional({
    description: "Filter by solver address that accepted/filled the intent",
  })
  @IsOptional()
  @IsString()
  solver?: string;

  @ApiPropertyOptional({
    description: "Sort dimension and direction: created|deadline|usd, optionally with :asc or :desc (default created:desc)",
  })
  @IsOptional()
  @Matches(SORT_PATTERN, {
    message: "sort must be one of created, deadline, or usd, optionally followed by :asc or :desc",
  })
  sort?: string;

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
