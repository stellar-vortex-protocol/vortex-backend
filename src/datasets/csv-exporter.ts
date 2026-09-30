import { DatasetRow, DatasetSchema } from "./datasets.types";
import { fieldNames } from "./schemas";

/**
 * Minimal, dependency-free CSV serialiser for the flat dataset rows.
 *
 * Emits RFC 4180-compliant CSV: a header row using the schema's column order,
 * followed by one row per record.  Strings are quoted/escaped only when needed
 * (commas, quotes, or newlines).  `null` becomes the empty field.
 */

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cellToString(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Serialise rows to CSV bytes (UTF-8, LF line endings). */
export function toCsv(schema: DatasetSchema, rows: DatasetRow[]): Buffer {
  const names = fieldNames(schema);
  const lines: string[] = [names.join(",")];

  for (const row of rows) {
    const cells = names.map((name) => escapeField(cellToString(row[name])));
    lines.push(cells.join(","));
  }

  return Buffer.from(lines.join("\n") + "\n", "utf8");
}
