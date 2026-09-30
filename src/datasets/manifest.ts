import { sha256Hex } from "./privacy";
import { schemaId } from "./schemas";
import {
  DatasetFile,
  DatasetFormat,
  DatasetKind,
  DatasetManifest,
  DatasetSchema,
} from "./datasets.types";

/** Compute the SHA-256 hex digest of a buffer. */
export function checksum(data: Buffer): string {
  return sha256Hex(data);
}

export interface ManifestFileInput {
  format: DatasetFormat;
  kind: DatasetKind;
  bytes: Buffer | null;
}

/**
 * Build a `manifest.json` for a publication.  `bytes` of `null` indicates a
 * dataset that had zero rows and therefore no artifact (e.g. Parquet cannot
 * represent an empty file); such entries are omitted from `files` but still
 * contribute a zero row count.
 */
export function buildManifest(input: {
  schema: DatasetSchema;
  date: string;
  revision: number;
  generatedAt: Date;
  watermark: Date | null;
  rowCounts: Record<DatasetKind, number>;
  files: ManifestFileInput[];
}): DatasetManifest {
  const files: DatasetFile[] = input.files
    .filter((f) => f.bytes !== null)
    .map((f) => {
      const bytes = f.bytes as Buffer;
      return {
        name: `${f.kind}.${f.format}`,
        format: f.format,
        rowCount: input.rowCounts[f.kind],
        sizeBytes: bytes.length,
        sha256: checksum(bytes),
      };
    });

  return {
    schema: schemaId(input.schema),
    schemaVersion: `${input.schema.version.major}.${input.schema.version.minor}`,
    generatedAt: input.generatedAt.toISOString(),
    date: input.date,
    revision: input.revision,
    watermark: input.watermark ? input.watermark.toISOString() : null,
    rowCounts: { ...input.rowCounts },
    files,
  };
}
