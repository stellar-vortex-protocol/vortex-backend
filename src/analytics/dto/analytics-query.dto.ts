import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { ANALYTICS_INTERVALS, AnalyticsInterval } from "../analytics.types";

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
}
