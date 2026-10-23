/**
 * Issue #407 — copy existing `intent_audit_log` rows into the partitioned
 * shadow table `intent_audit_log_p` before the staged swap.
 *
 * Usage:
 *   npm run db:backfill-audit-partitions
 *   npm run db:backfill-audit-partitions -- --verify        # count missing rows, write nothing
 *   npm run db:backfill-audit-partitions -- --batch-size 2000 --sleep-ms 50
 *   npm run db:backfill-audit-partitions -- --fresh         # ignore the saved cursor
 *
 * Rows are walked by id (the primary key) in batches of at most 5,000, one
 * transaction and one statement per batch, with `lock_timeout = 1s`. Copies
 * use `ON CONFLICT DO NOTHING`, so rows the mirror trigger already wrote are
 * skipped and the script is safe to re-run. Monthly partitions are created
 * first for every month in the data, so no copied row lands in the default
 * partition. The last copied id is saved to the state file after every batch.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

export const SOURCE = "intent_audit_log";
export const TARGET = "intent_audit_log_p";
export const MAX_BATCH_SIZE = 5_000;
const COLUMNS = `"id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata"`;

/** Minimal client surface — a PrismaClient or a test double. */
export interface SqlClient {
  $transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export interface SqlTx {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

/** One batch: `$1` = last copied id (exclusive), `$2` = limit. */
export const BATCH_SQL = `
  WITH batch AS (
    SELECT ${COLUMNS} FROM "${SOURCE}" WHERE "id" > $1::bigint ORDER BY "id" LIMIT $2::int
  ), ins AS (
    INSERT INTO "${TARGET}" (${COLUMNS})
    SELECT ${COLUMNS} FROM batch
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT max("id") FROM batch)::text AS "lastId",
         (SELECT count(*) FROM batch)::int  AS "scanned",
         (SELECT count(*) FROM ins)::int    AS "copied"`;

export const MISSING_SQL = `
  SELECT count(*)::int AS n FROM "${SOURCE}" o
  WHERE NOT EXISTS (SELECT 1 FROM "${TARGET}" n WHERE n."id" = o."id" AND n."timestamp" = o."timestamp")`;

/** Create the monthly partition for every month present in the source table. */
export const ENSURE_PARTITIONS_SQL = `
  SELECT "intent_audit_log_ensure_partition"('"${TARGET}"'::regclass, m::date) AS part
  FROM generate_series(
    date_trunc('month', (SELECT min("timestamp") FROM "${SOURCE}")),
    date_trunc('month', (SELECT max("timestamp") FROM "${SOURCE}")),
    interval '1 month') AS m`;

export interface CopyOptions {
  batchSize?: number;
  /** Resume after this id (exclusive). */
  startAfterId?: bigint;
  onBatch?: (progress: { lastId: bigint; scanned: number; copied: number; ms: number }) => void;
  sleepMs?: number;
  maxRetries?: number;
}

export interface CopyResult {
  scanned: number;
  copied: number;
  batches: number;
  lastId: bigint | null;
}

const RETRYABLE = new Set(["55P03", "57014", "40001", "40P01"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return e.meta?.code ?? (e.code && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined) ?? e.message?.match(/\b(55P03|57014|40001|40P01)\b/)?.[1];
}

/** Copy every source row with id > startAfterId into the partitioned table. */
export async function copyAuditRows(db: SqlClient, opts: CopyOptions = {}): Promise<CopyResult> {
  const batchSize = opts.batchSize ?? MAX_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be an integer in 1..${MAX_BATCH_SIZE}, got ${batchSize}`);
  }
  const result: CopyResult = { scanned: 0, copied: 0, batches: 0, lastId: opts.startAfterId ?? null };
  let cursor = opts.startAfterId ?? 0n;

  for (;;) {
    const started = Date.now();
    let attempt = 0;
    let row: { lastId: string | null; scanned: number; copied: number };
    for (;;) {
      try {
        row = await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '30s'`);
          const rows = await tx.$queryRawUnsafe<Array<{ lastId: string | null; scanned: number; copied: number }>>(
            BATCH_SQL,
            cursor.toString(),
            batchSize,
          );
          return rows[0];
        });
        break;
      } catch (err) {
        const code = pgCode(err);
        if (!code || !RETRYABLE.has(code) || attempt >= (opts.maxRetries ?? 5)) throw err;
        attempt++;
        await sleep(Math.min(5_000, 100 * 2 ** attempt));
      }
    }
    if (!row.lastId || Number(row.scanned) === 0) return result;
    cursor = BigInt(row.lastId);
    result.lastId = cursor;
    result.scanned += Number(row.scanned);
    result.copied += Number(row.copied);
    result.batches++;
    opts.onBatch?.({ lastId: cursor, scanned: Number(row.scanned), copied: Number(row.copied), ms: Date.now() - started });
    if (Number(row.scanned) < batchSize) return result;
    if (opts.sleepMs) await sleep(opts.sleepMs);
  }
}

/** Rows present in the live table but not (yet) in the partitioned one. */
export async function countMissing(db: SqlClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(MISSING_SQL);
  return Number(rows[0]?.n ?? 0);
}

/** Make sure a partition exists for every month in the source data. */
export async function ensurePartitionsForData(db: SqlClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ part: string }>>(ENSURE_PARTITIONS_SQL);
  return rows.map((r) => r.part);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    batchSize: Number(get("batch-size") ?? MAX_BATCH_SIZE),
    stateFile: get("state-file") ?? ".backfill-audit-partitions.json",
    fresh: argv.includes("--fresh"),
    verifyOnly: argv.includes("--verify"),
    sleepMs: Number(get("sleep-ms") ?? 0),
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const db = new PrismaClient() as unknown as SqlClient & { $disconnect(): Promise<void> };
  try {
    if (cli.verifyOnly) {
      const n = await countMissing(db);
      console.log(`${n} row(s) missing from ${TARGET}`);
      process.exitCode = n === 0 ? 0 : 1;
      return;
    }
    const parts = await ensurePartitionsForData(db);
    console.log(`partitions ready: ${parts.length} month(s)`);

    let startAfterId: bigint | undefined;
    if (!cli.fresh && existsSync(cli.stateFile)) {
      startAfterId = BigInt((JSON.parse(readFileSync(cli.stateFile, "utf8")) as { lastId: string }).lastId);
      console.log(`resuming after id ${startAfterId}`);
    }
    const result = await copyAuditRows(db, {
      batchSize: cli.batchSize,
      startAfterId,
      sleepMs: cli.sleepMs,
      onBatch: (p) => {
        writeFileSync(cli.stateFile, JSON.stringify({ lastId: p.lastId.toString() }));
        const slow = p.ms > 1_000 ? "  ⚠ batch took >1s — consider a smaller --batch-size" : "";
        console.log(`  scanned ${p.scanned}, copied ${p.copied}, up to id ${p.lastId} (${p.ms} ms)${slow}`);
      },
    });
    console.log(`done — ${result.scanned} scanned, ${result.copied} copied in ${result.batches} batch(es)`);
    const missing = await countMissing(db);
    console.log(`${missing} row(s) missing from ${TARGET}`);
    if (missing > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
