/**
 * Shared types for the public anonymised datasets subsystem.
 *
 * These datasets are the stable, versioned public contract the community
 * consumes instead of scraping the live API.  Every exported row is flat and
 * scalar-only so it can be losslessly serialised to both CSV and Parquet.
 */

/** The four public dataset families. */
export const DATASET_KINDS = ["intents", "fills", "solver_stats", "fees"] as const;

export type DatasetKind = (typeof DATASET_KINDS)[number];

/** Scalar field types supported by both CSV and Parquet serialisation. */
export type SchemaFieldType = "string" | "int64" | "boolean" | "double";

/**
 * A single column in a dataset schema.  Additive-by-default policy means a
 * field, once published, must never be renamed, retyped, or removed — only
 * new *optional* fields may be appended (which bumps the minor version).
 */
export interface SchemaField {
  name: string;
  type: SchemaFieldType;
  optional?: boolean;
  description?: string;
}

/** Semantic version for a dataset schema. */
export interface SchemaVersion {
  major: number;
  minor: number;
}

/** A versioned dataset schema. */
export interface DatasetSchema {
  name: DatasetKind;
  version: SchemaVersion;
  fields: SchemaField[];
}

/** A flat, scalar-only row.  Values are the JSON-compatible primitives above. */
export type DatasetRow = Record<string, string | number | boolean | null>;

/** File formats a dataset can be exported as. */
export const DATASET_FORMATS = ["csv", "parquet"] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];

/** One serialised artifact inside a dataset publication. */
export interface DatasetFile {
  /** File name, e.g. `intents.csv`. */
  name: string;
  format: DatasetFormat;
  rowCount: number;
  sizeBytes: number;
  /** SHA-256 hex digest of the file bytes. */
  sha256: string;
}

/**
 * The `manifest.json` written alongside every published dataset.  It is the
 * single source of truth for provenance: schema version, row counts, content
 * checksums, and the high-water mark.
 */
export interface DatasetManifest {
  /** Schema id, e.g. `intents-v1.0`. */
  schema: string;
  schemaVersion: string;
  /** ISO-8601 UTC timestamp when the manifest was generated. */
  generatedAt: string;
  /** UTC date (YYYY-MM-DD) this publication covers. */
  date: string;
  /**
   * Publication revision for this date.  Starts at 1 and increments each time
   * the date is re-published to repair late-arriving / reconciled data.
   */
  revision: number;
  /**
   * High-water mark: the maximum event timestamp (ISO-8601 UTC) covered by
   * this publication, or `null` when the date has no rows.
   */
  watermark: string | null;
  /** Total rows per dataset kind present in this publication. */
  rowCounts: Record<DatasetKind, number>;
  files: DatasetFile[];
}

/** Configuration controlling dataset publication behaviour. */
export interface DatasetsConfig {
  enabled: boolean;
  /** Hash user addresses with the rotating salt before export. */
  anonymize: boolean;
  /** Base salt secret (never exposed). Rotating salts are derived from it. */
  salt: string;
  /** How often the anonymisation salt rotates, in hours. */
  saltRotationHours: number;
  /** How many previous salt windows are retained for continuity. */
  saltRetentionWindows: number;
  /** Public object-storage bucket / prefix datasets are published under. */
  publicBucket: string;
  /** Storage backend: "local" writes to disk, "memory" is for tests. */
  storageKind: "local" | "memory";
  /** Root directory for the local storage backend. */
  localDir: string;
}
