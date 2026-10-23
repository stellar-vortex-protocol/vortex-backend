/**
 * Issue #409 — resumable backfill between the epoch-second INTEGER columns and
 * their timestamptz twins.
 *
 *   intents.created_at / deadline / filled_at   ↔ *_ts
 *   solvers.registered_at / last_active_at      ↔ *_ts
 *
 * Usage:
 *   npm run db:backfill-timestamps                       # epoch → timestamptz, all tables
 *   npm run db:backfill-timestamps -- --verify           # count out-of-sync rows, write nothing
 *   npm run db:backfill-timestamps -- --table solvers --batch-size 2000
 *   npm run db:backfill-timestamps -- --direction to-epoch   # rollback of the contract step
 *   npm run db:backfill-timestamps -- --fresh            # ignore the saved cursor
 *
 * Batching and locks: rows are walked by primary key (keyset pagination) in
 * batches of at most 5,000 rows, one transaction and ONE statement per batch,
 * with `lock_timeout = 1s`. A batch that cannot get its row locks within a
 * second fails fast and is retried with backoff instead of queueing behind
 * application writes. Only rows that are actually out of sync are written.
 *
 * Resumable: the last processed primary key per table is saved to the state
 * file after every batch (`--state-file`, default `.backfill-timestamps.json`)
 * and picked up on the next run. Re-running from scratch is also safe — the
 * update is idempotent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

export type Direction = "to-ts" | "to-epoch";

export interface TableSpec {
  table: "intents" | "solvers";
  /** Epoch INTEGER column → its timestamptz twin. */
  pairs: ReadonlyArray<{ epoch: string; ts: string }>;
}

export const TABLES: readonly TableSpec[] = [
  {
    table: "intents",
    pairs: [
      { epoch: "created_at", ts: "created_at_ts" },
      { epoch: "deadline", ts: "deadline_ts" },
      { epoch: "filled_at", ts: "filled_at_ts" },
    ],
  },
  {
    table: "solvers",
    pairs: [
      { epoch: "registered_at", ts: "registered_at_ts" },
      { epoch: "last_active_at", ts: "last_active_at_ts" },
    ],
  },
];

/** Upper bound from the issue: ≤ 5k rows per transaction. */
export const MAX_BATCH_SIZE = 5_000;

/** Minimal client surface — a PrismaClient or a test double. */
export interface SqlClient {
  $transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export interface SqlTx {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** SQL predicate: true when any pair of `spec` disagrees on row alias `t`. */
export function outOfSyncPredicate(spec: TableSpec, alias = "t"): string {
  return spec.pairs
    .map(({ epoch, ts }) => `${alias}.${q(ts)} IS DISTINCT FROM to_timestamp(${alias}.${q(epoch)})`)
    .join(" OR ");
}

/** The single statement one batch runs. `$1` = cursor (exclusive), `$2` = limit. */
export function batchSql(spec: TableSpec, direction: Direction): string {
  const set = spec.pairs
    .map(({ epoch, ts }) =>
      direction === "to-ts"
        ? `${q(ts)} = to_timestamp(t.${q(epoch)})`
        : `${q(epoch)} = floor(extract(epoch FROM t.${q(ts)}))::integer`,
    )
    .join(", ");
  return `
    WITH batch AS (
      SELECT "id" FROM ${q(spec.table)} WHERE "id" > $1 ORDER BY "id" LIMIT $2
    ), upd AS (
      UPDATE ${q(spec.table)} t SET ${set}
      FROM batch
      WHERE t."id" = batch."id" AND (${outOfSyncPredicate(spec)})
      RETURNING t."id"
    )
    SELECT (SELECT max("id") FROM batch) AS "lastId",
           (SELECT count(*) FROM batch)::int AS "scanned",
           (SELECT count(*) FROM upd)::int AS "updated"`;
}

export interface BackfillOptions {
  direction?: Direction;
  batchSize?: number;
  /** Resume after this primary key (exclusive). */
  startAfterId?: string;
  /** Called after every committed batch — persist the cursor here. */
  onBatch?: (progress: { table: string; lastId: string; scanned: number; updated: number; ms: number }) => void;
  /** Pause between batches to leave headroom for application traffic. */
  sleepMs?: number;
  maxRetries?: number;
}

export interface BackfillResult {
  table: string;
  scanned: number;
  updated: number;
  batches: number;
  lastId: string | null;
}

const RETRYABLE = new Set(["55P03" /* lock_not_available */, "57014" /* query_canceled (statement timeout) */, "40001", "40P01"]);

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return e.meta?.code ?? (e.code && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined) ?? e.message?.match(/\b(55P03|57014|40001|40P01)\b/)?.[1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Walk one table in keyset batches until every row has been visited. */
export async function backfillTable(db: SqlClient, spec: TableSpec, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const batchSize = opts.batchSize ?? MAX_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be an integer in 1..${MAX_BATCH_SIZE}, got ${batchSize}`);
  }
  const sql = batchSql(spec, opts.direction ?? "to-ts");
  const result: BackfillResult = { table: spec.table, scanned: 0, updated: 0, batches: 0, lastId: opts.startAfterId ?? null };
  let cursor = opts.startAfterId ?? "";

  for (;;) {
    let attempt = 0;
    let row: { lastId: string | null; scanned: number; updated: number };
    const started = Date.now();
    for (;;) {
      try {
        row = await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '30s'`);
          const rows = await tx.$queryRawUnsafe<Array<{ lastId: string | null; scanned: number; updated: number }>>(
            sql,
            cursor,
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
    if (!row.lastId || row.scanned === 0) return result;
    cursor = row.lastId;
    result.lastId = row.lastId;
    result.scanned += Number(row.scanned);
    result.updated += Number(row.updated);
    result.batches++;
    opts.onBatch?.({ table: spec.table, lastId: row.lastId, scanned: Number(row.scanned), updated: Number(row.updated), ms: Date.now() - started });
    if (Number(row.scanned) < batchSize) return result;
    if (opts.sleepMs) await sleep(opts.sleepMs);
  }
}

/** Count rows whose pairs disagree (including a NULL twin of a non-NULL value). */
export async function countOutOfSync(db: SqlClient, spec: TableSpec): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM ${q(spec.table)} t WHERE ${outOfSyncPredicate(spec)}`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Cli {
  tables: TableSpec[];
  direction: Direction;
  batchSize: number;
  stateFile: string;
  fresh: boolean;
  verifyOnly: boolean;
  sleepMs: number;
}

export function parseArgs(argv: string[]): Cli {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const table = get("table") ?? "all";
  const tables = table === "all" ? [...TABLES] : TABLES.filter((t) => t.table === table);
  if (tables.length === 0) throw new Error(`--table must be intents, solvers or all, got ${table}`);
  const direction = (get("direction") ?? "to-ts") as Direction;
  if (direction !== "to-ts" && direction !== "to-epoch") throw new Error(`--direction must be to-ts or to-epoch`);
  return {
    tables,
    direction,
    batchSize: Number(get("batch-size") ?? MAX_BATCH_SIZE),
    stateFile: get("state-file") ?? ".backfill-timestamps.json",
    fresh: argv.includes("--fresh"),
    verifyOnly: argv.includes("--verify"),
    sleepMs: Number(get("sleep-ms") ?? 0),
  };
}

type State = Partial<Record<string, string>> & { direction?: Direction };

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    if (cli.verifyOnly) {
      let total = 0;
      for (const spec of cli.tables) {
        const n = await countOutOfSync(db as unknown as SqlClient, spec);
        total += n;
        console.log(`${spec.table}: ${n} row(s) out of sync`);
      }
      process.exitCode = total === 0 ? 0 : 1;
      return;
    }

    let state: State = {};
    if (!cli.fresh && existsSync(cli.stateFile)) {
      state = JSON.parse(readFileSync(cli.stateFile, "utf8")) as State;
      if (state.direction && state.direction !== cli.direction) {
        throw new Error(`${cli.stateFile} was written for --direction ${state.direction}; pass --fresh to start over`);
      }
    }
    state.direction = cli.direction;

    for (const spec of cli.tables) {
      const startAfterId = state[spec.table];
      console.log(`${spec.table}: ${cli.direction}${startAfterId ? ` resuming after id ${startAfterId}` : ""}`);
      const result = await backfillTable(db as unknown as SqlClient, spec, {
        direction: cli.direction,
        batchSize: cli.batchSize,
        startAfterId,
        sleepMs: cli.sleepMs,
        onBatch: (p) => {
          state[p.table] = p.lastId;
          writeFileSync(cli.stateFile, JSON.stringify(state, null, 2));
          const slow = p.ms > 1_000 ? "  ⚠ batch took >1s — consider a smaller --batch-size" : "";
          console.log(`  ${p.table}: scanned ${p.scanned}, updated ${p.updated}, up to ${p.lastId} (${p.ms} ms)${slow}`);
        },
      });
      console.log(`${spec.table}: done — ${result.scanned} scanned, ${result.updated} updated in ${result.batches} batch(es)`);
    }

    for (const spec of cli.tables) {
      const n = await countOutOfSync(db as unknown as SqlClient, spec);
      console.log(`${spec.table}: ${n} row(s) out of sync after backfill`);
      if (n > 0) process.exitCode = 1;
    }
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
