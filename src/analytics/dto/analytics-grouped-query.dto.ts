import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import {
  ANALYTICS_INTERVALS,
  AnalyticsInterval,
  GROUP_BY_DIMENSIONS,
  GROUPED_METRICS,
  GroupByDimension,
  GroupedMetric,
} from "../analytics.types";

/**
 * Body for `POST /api/v1/analytics/query`.
 *
 * `groupBy` is restricted to the enumerated GROUP_BY_DIMENSIONS; anything else
 * is rejected with 400 here, before it can reach a store. The SQL backend
 * additionally maps each value to a fixed column name (defence in depth).
 */
export class AnalyticsGroupedQueryDto {
  @ApiProperty({ enum: GROUPED_METRICS })
  @IsIn(GROUPED_METRICS)
  metric!: GroupedMetric;

  @ApiPropertyOptional({ enum: ANALYTICS_INTERVALS, default: "1d" })
  @IsOptional()
  @IsIn(ANALYTICS_INTERVALS)
  interval: AnalyticsInterval = "1d";

  /** Inclusive lower bound, Unix epoch seconds. */
  @ApiProperty({ description: "Inclusive lower bound, Unix epoch seconds" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from!: number;

  /** Exclusive upper bound, Unix epoch seconds. */
  @ApiProperty({ description: "Exclusive upper bound, Unix epoch seconds" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to!: number;

  @ApiPropertyOptional({
    enum: GROUP_BY_DIMENSIONS,
    isArray: true,
    default: [],
    description: "Dimensions to group by. Empty returns one row per bucket.",
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(GROUP_BY_DIMENSIONS, { each: true })
  groupBy: GroupByDimension[] = [];

  @ApiPropertyOptional({ description: "Only include fills from this source chain" })
  @IsOptional()
  @IsString()
  chain?: string;

  @ApiPropertyOptional({ description: "Only include fills whose source or destination token matches" })
  @IsOptional()
  @IsString()
  token?: string;
}
