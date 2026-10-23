import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { AdminGuard, RequireAdminRole } from "../admin/admin.guard";
import { DatasetsService } from "./datasets.service";
import { DatasetRangeExportManifest } from "./datasets.types";
import { ExportDatasetRangeDto } from "./dto/export-dataset-range.dto";

/** Response headers carrying the export's manifest, one per field. */
const MANIFEST_HEADERS: Record<string, keyof DatasetRangeExportManifest> = {
  "X-Dataset-Schema": "schema",
  "X-Dataset-Schema-Version": "schemaVersion",
  "X-Dataset-Kind": "kind",
  "X-Dataset-From": "from",
  "X-Dataset-To": "to",
  "X-Dataset-Row-Count": "rowCount",
  "X-Dataset-Sha256": "sha256",
  "X-Dataset-Generated-At": "generatedAt",
};

/**
 * Operator-only, on-demand dataset export over a range of UTC days (issue #592).
 *
 * Not a public contract: the daily publication under `GET /api/v1/datasets`
 * stays the public surface (docs/public-transparency-contract.md).
 */
@ApiTags("admin")
@ApiHeader({ name: "x-admin-key", required: true })
@Controller({ path: "admin/datasets", version: "1" })
@UseGuards(AdminGuard)
@RequireAdminRole("admin")
export class AdminDatasetsController {
  constructor(private readonly datasets: DatasetsService) {}

  @Post("export")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Export one dataset kind over a range of UTC days as a single CSV or Parquet file",
    description:
      "Rows are built and anonymised exactly as in the daily publication. The manifest (schema, row count, " +
      "SHA-256, from/to) is returned in X-Dataset-* response headers. Ranges wider than " +
      "DATASETS_EXPORT_MAX_DAYS are rejected with 400.",
  })
  @ApiProduces("text/csv", "application/vnd.apache.parquet")
  @ApiResponse({
    status: 400,
    description: "Invalid dates, to before from, or range too wide",
  })
  @ApiResponse({
    status: 404,
    description: "Parquet requested for a range with no rows",
  })
  async export(
    @Body() dto: ExportDatasetRangeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { manifest, body, contentType } =
      await this.datasets.exportRange(dto);

    for (const [header, field] of Object.entries(MANIFEST_HEADERS)) {
      res.setHeader(header, String(manifest[field]));
    }
    if (manifest.watermark)
      res.setHeader("X-Dataset-Watermark", manifest.watermark);
    res.setHeader(
      "Access-Control-Expose-Headers",
      [...Object.keys(MANIFEST_HEADERS), "X-Dataset-Watermark"].join(", "),
    );

    return new StreamableFile(body, {
      type: contentType,
      length: body.length,
      disposition: `attachment; filename="${manifest.fileName}"`,
    });
  }
}
