import { createHash } from "node:crypto";

/**
 * Archival manifest entry for one date partition (#413).
 *
 * The manifest is written to S3 alongside the Parquet files so a restore
 * command can verify checksums before importing rows into Postgres.
 */
export interface ArchivalManifest {
  /** ISO-8601 date of the partition (YYYY-MM-DD). */
  date: string;
  /** UTC timestamp when the archival job ran. */
  archivedAt: string;
  files: ManifestFile[];
  /** Total row counts across all files. */
  totalIntentRows: number;
  totalAuditRows: number;
}

export interface ManifestFile {
  /** S3 key relative to the bucket root. */
  key: string;
  /** File type: "intents" | "audit". */
  type?: "intents" | "audit";
  kind?: "intents" | "audit";
  /** Number of rows in this file. */
  rowCount?: number;
  rows?: number;
  /** SHA-256 hex digest of the file's raw bytes. */
  sha256: string;
  /** File size in bytes. */
  sizeBytes?: number;
  bytes?: number;
}

/** Compute the SHA-256 hex digest of a buffer. */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Verify that every file in `manifest` has the expected SHA-256 digest.
 *
 * @param manifest  The manifest to verify.
 * @param fileLoader  Async function that fetches a file by its S3 key.
 * @throws Error when any file's digest does not match.
 */
export async function verifyManifest(
  manifest: ArchivalManifest,
  fileLoader: (key: string) => Promise<Buffer>,
): Promise<void> {
  for (const file of manifest.files) {
    const data = await fileLoader(file.key);
    const actual = sha256Hex(data);
    if (actual !== file.sha256) {
      throw new Error(
        `Manifest checksum mismatch for ${file.key}: expected ${file.sha256}, got ${actual}`,
      );
    }
    const expectedSize = file.sizeBytes ?? file.bytes;
    if (expectedSize !== undefined && data.length !== expectedSize) {
      throw new Error(
        `Manifest size mismatch for ${file.key}: expected ${expectedSize} bytes, got ${data.length}`,
      );
    }
  }
}
