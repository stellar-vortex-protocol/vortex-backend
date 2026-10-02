import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
// @dsnp/parquetjs is aliased as "parquetjs" in package.json
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parquet = require("parquetjs");

/**
 * Parquet schema for archived intent rows (#413).
 *
 * All fields mirror the `intents` table columns used by analytics.
 * BigInt amounts are stored as UTF8 strings — INT96 is deprecated and
 * not consistently supported by DuckDB / Athena.
 *
 * JSON columns are stored as UTF8 strings so downstream query engines
 * can use json_extract / JSON_EXTRACT_PATH.
 */
function makeIntentSchema() {
  return new parquet.ParquetSchema({
    intent_id:           { type: "UTF8" },
    user:                { type: "UTF8" },
    src_chain:           { type: "UTF8" },
    src_token:           { type: "UTF8" },
    src_amount:          { type: "UTF8" },
    dst_token:           { type: "UTF8" },
    min_dst_amount:      { type: "UTF8" },
    quoted_dst_amount:   { type: "UTF8", optional: true },
    accepted_dst_amount: { type: "UTF8", optional: true },
    fill_amount:         { type: "UTF8", optional: true },
    fee_amount:          { type: "UTF8", optional: true },
    solver:              { type: "UTF8", optional: true },
    state:               { type: "UTF8" },
    created_at:          { type: "INT64" },
    deadline:            { type: "INT64" },
    filled_at:           { type: "INT64", optional: true },
    slashed_at:          { type: "INT64", optional: true },
    slash_reason:        { type: "UTF8", optional: true },
    tx_hash:             { type: "UTF8", optional: true },
    version:             { type: "INT32" },
    src_verified:        { type: "BOOLEAN" },
    src_token_id:        { type: "UTF8", optional: true },
    dst_token_id:        { type: "UTF8", optional: true },
    src_decimals:        { type: "INT32", optional: true },
    dst_decimals:        { type: "INT32", optional: true },
  });
}

function makeAuditSchema() {
  return new parquet.ParquetSchema({
    id:         { type: "INT64" },
    intent_id:  { type: "UTF8" },
    timestamp:  { type: "UTF8" },
    to_state:   { type: "UTF8" },
    actor:      { type: "UTF8" },
    reason:     { type: "UTF8" },
    metadata:   { type: "UTF8", optional: true },
  });
}

export type IntentParquetRow = Record<string, unknown>;
export type AuditParquetRow = Record<string, unknown>;

/**
 * Write rows to a Parquet file via a temp file, then return the Buffer.
 * The temp file is cleaned up whether or not the write succeeds.
 */
async function writeParquetToBuffer(
  schema: unknown,
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  const tmpPath = join(tmpdir(), `vortex-archive-${randomBytes(8).toString("hex")}.parquet`);
  let writer: { appendRow(row: unknown): Promise<void>; close(): Promise<void> } | undefined;

  try {
    writer = await parquet.ParquetWriter.openFile(schema, tmpPath);
    for (const row of rows) {
      await writer!.appendRow(row);
    }
    await writer!.close();
    writer = undefined; // prevent double-close in finally
    return readFileSync(tmpPath);
  } finally {
    // Ensure close is called if appendRow threw mid-stream.
    if (writer) {
      try { await writer.close(); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpPath); } catch { /* file may not exist */ }
  }
}

/**
 * Write a batch of intent rows to an in-memory Parquet buffer.
 */
export async function writeIntentsParquet(rows: IntentParquetRow[]): Promise<Buffer> {
  return writeParquetToBuffer(makeIntentSchema(), rows as Record<string, unknown>[]);
}

/**
 * Write a batch of audit entries to an in-memory Parquet buffer.
 */
export async function writeAuditParquet(rows: AuditParquetRow[]): Promise<Buffer> {
  return writeParquetToBuffer(makeAuditSchema(), rows as Record<string, unknown>[]);
}

/**
 * Read Parquet rows back from a Buffer (used by the restore script).
 */
export async function readParquetFromBuffer(buf: Buffer): Promise<Record<string, unknown>[]> {
  const reader = await parquet.ParquetReader.openBuffer(buf);
  const cursor = reader.getCursor();
  const rows: Record<string, unknown>[] = [];
  let row: Record<string, unknown> | null;
  while ((row = await cursor.next()) !== null) {
    rows.push(row);
  }
  await reader.close();
  return rows;
}
