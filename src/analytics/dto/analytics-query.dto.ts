import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
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

  /** Source-chain filter. */
  @IsOptional()
  @IsString()
  chain?: string;

  /** Matches the source or destination token symbol. */
  @IsOptional()
  @IsString()
  token?: string;

  /** Only count fills by this solver address (ignored by solver-benchmark). */
  @IsOptional()
  @IsString()
  solver?: string;

  @ApiPropertyOptional({
    description:
      "Source chain of the corridor. Only valid for the chain-pair metric.",
  })
  @IsOptional()
  @IsString()
  srcChain?: string;

  @ApiPropertyOptional({
    description:
      "Destination chain of the corridor. Only valid for the chain-pair metric.",
  })
  @IsOptional()
  @IsString()
  dstChain?: string;

  @ApiPropertyOptional({
    enum: ANALYTICS_FORMATS,
    default: "json",
    description:
      "Response format. `csv` returns text/csv with one row per point. `Accept: text/csv` also works.",
  })
  @IsOptional()
  @IsIn(ANALYTICS_FORMATS)
  format?: AnalyticsFormat;
}
