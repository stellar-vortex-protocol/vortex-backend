import { ApiProperty } from "@nestjs/swagger";
import { IsIn, Matches } from "class-validator";
import {
  DATASET_FORMATS,
  DATASET_KINDS,
  DatasetFormat,
  DatasetKind,
} from "../datasets.types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Body of `POST /api/v1/admin/datasets/export` (issue #592). */
export class ExportDatasetRangeDto {
  @ApiProperty({ enum: DATASET_KINDS })
  @IsIn(DATASET_KINDS)
  kind!: DatasetKind;

  @ApiProperty({
    example: "2026-01-01",
    description: "First UTC day included (YYYY-MM-DD)",
  })
  @Matches(DAY, { message: "from must be a UTC date in YYYY-MM-DD form" })
  from!: string;

  @ApiProperty({
    example: "2026-01-31",
    description: "Last UTC day included (YYYY-MM-DD)",
  })
  @Matches(DAY, { message: "to must be a UTC date in YYYY-MM-DD form" })
  to!: string;

  @ApiProperty({ enum: DATASET_FORMATS })
  @IsIn(DATASET_FORMATS)
  format!: DatasetFormat;
}
