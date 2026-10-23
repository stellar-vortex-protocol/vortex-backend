import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { ANALYTICS_INTERVALS, AnalyticsInterval } from "../analytics.types";

export const ANALYTICS_FORMATS = ["json", "csv"] as const;
export type AnalyticsFormat = (typeof ANALYTICS_FORMATS)[number];

export class AnalyticsQueryDto {
  @IsIn(ANALYTICS_INTERVALS)
  interval: AnalyticsInterval = "1d";

  /** Inclusive lower bound, Unix epoch seconds. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from!: number;

  /** Exclusive upper bound, Unix epoch seconds. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to!: number;

  @IsOptional()
  @IsString()
  chain?: string;

  @IsOptional()
  @IsString()
  token?: string;

  /** Only count fills by this solver address (ignored by solver-benchmark). */
  @IsOptional()
  @IsString()
  solver?: string;

  /** Response format. Defaults to JSON; `csv` returns `text/csv`. */
  @ApiPropertyOptional({ enum: ANALYTICS_FORMATS, default: "json" })
  @IsOptional()
  @IsIn(ANALYTICS_FORMATS)
  format?: AnalyticsFormat;
}
