import { ParquetEnvelopeWriter, ParquetSchema, ParquetWriter } from "parquetjs";
import { DatasetRow, DatasetSchema, SchemaField } from "./datasets.types";

/**
 * Parquet serialiser backed by `parquetjs`, writing to an in-memory buffer so
 * artifacts can be checksummed and published to object storage without touching
 * the local filesystem.
 */

/** Map a logical field type to the Parquet primitive type name. */
function parquetType(field: SchemaField): string {
  switch (field.type) {
    case "string":
      return "UTF8";
    case "int64":
      return "INT64";
    case "boolean":
      return "BOOLEAN";
    case "double":
      return "DOUBLE";
  }
}

function toParquetSchema(schema: DatasetSchema): ParquetSchema {
  const definition: Record<string, { type: string; optional?: boolean }> = {};
  for (const field of schema.fields) {
    definition[field.name] = { type: parquetType(field), optional: field.optional ?? false };
  }
  return new ParquetSchema(definition);
}

/** Coerce a row value into the scalar type `parquetjs` expects for the field. */
function coerceValue(
  field: SchemaField,
  value: string | number | boolean | null,
): string | number | boolean | Date | undefined {
  if (value === null || value === undefined) {
    // Optional fields accept null; required fields should never be null.
    return undefined;
  }
  switch (field.type) {
    case "int64": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isInteger(n) ? n : Math.trunc(n);
    }
    case "double":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
      return typeof value === "boolean" ? value : value === "true";
    case "string":
      return String(value);
  }
}

/**
 * Serialise rows to a Parquet file buffer.  Returns `null` when there are no
 * rows (Parquet cannot represent a zero-row file), so callers can omit the
 * artifact and record a zero row count in the manifest instead.
 */
export async function toParquet(
  schema: DatasetSchema,
  rows: DatasetRow[],
  metadata: Record<string, string> = {},
): Promise<Buffer | null> {
  if (rows.length === 0) return null;

  const parquetSchema = toParquetSchema(schema);
  const chunks: Buffer[] = [];

  const envelopeWriter = new ParquetEnvelopeWriter(
    parquetSchema,
    async (buf: Buffer) => {
      chunks.push(buf);
    },
    async () => undefined,
    0,
    {},
  );

  const writer = new ParquetWriter(parquetSchema, envelopeWriter, {});

  for (const [key, value] of Object.entries(metadata)) {
    writer.setMetadata(key, value);
  }

  for (const row of rows) {
    const out: Record<string, string | number | boolean | Date> = {};
    for (const field of schema.fields) {
      const value = coerceValue(field, row[field.name]);
      // Optional fields with no value are omitted; parquetjs writes them as
      // null. Required fields are guaranteed non-null by the row mappers.
      if (value !== undefined) {
        out[field.name] = value;
      }
    }
    await writer.appendRow(out);
  }

  await writer.close();

  return Buffer.concat(chunks);
}
