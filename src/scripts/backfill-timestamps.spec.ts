/**
 * Issue #409 — epoch → timestamptz expand/contract.
 *
 * Unit part (always runs): SQL generation and argument parsing.
 *
 * Migration part (opt-in via TEST_DATABASE_URL): executes every phase against
 * a seeded database, in an isolated scratch schema so nothing else is touched:
 *
 *   legacy rows → expand migration → dual-writes → index migrations →
 *   enforce refused before backfill → interrupted + resumed backfill →
 *   staged steps 1–4 (verify, validate, NOT NULL, contract) →
 *   contract rollback + reverse backfill.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  backfillTable,
  batchSql,
  countOutOfSync,
  MAX_BATCH_SIZE,
  parseArgs,
  SqlClient,
  TABLES,
} from "../../scripts/backfill-timestamps";

const ROOT = join(__dirname, "../..");
const MIGRATIONS = join(ROOT, "prisma/migrations");
const STAGED = join(ROOT, "prisma/staged-migrations/409-epoch-timestamptz");

const intents = TABLES.find((t) => t.table === "intents")!;
const solvers = TABLES.find((t) => t.table === "solvers")!;

describe("backfill-timestamps (issue #409) — unit", () => {
  it("builds one keyset-paginated statement that only rewrites out-of-sync rows", () => {
    const sql = batchSql(intents, "to-ts");
    expect(sql).toContain(`WHERE "id" > $1 ORDER BY "id" LIMIT $2`);
    expect(sql).toContain(`"created_at_ts" = to_timestamp(t."created_at")`);
    expect(sql).toContain(`t."filled_at_ts" IS DISTINCT FROM to_timestamp(t."filled_at")`);
    expect(sql.match(/;/g)).toBeNull();
  });

  it("reverses the direction for the contract rollback", () => {
    expect(batchSql(solvers, "to-epoch")).toContain(
      `"last_active_at" = floor(extract(epoch FROM t."last_active_at_ts"))::integer`,
    );
  });

  it("parses CLI flags and enforces the 5k batch ceiling", () => {
    expect(parseArgs(["--table", "solvers", "--batch-size", "100", "--verify"])).toMatchObject({
      tables: [solvers],
      batchSize: 100,
      verifyOnly: true,
      direction: "to-ts",
    });
    expect(() => parseArgs(["--table", "nope"])).toThrow(/--table/);
    expect(() => parseArgs(["--direction", "sideways"])).toThrow(/--direction/);
    const fake = {} as SqlClient;
    return expect(backfillTable(fake, intents, { batchSize: MAX_BATCH_SIZE + 1 })).rejects.toThrow(/batch-size/);
  });
});

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

/** Adapt a pg Client to the script's Prisma-shaped SqlClient. */
function adapt(client: Client): SqlClient {
  const raw = {
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => (await client.query(sql, values)).rowCount ?? 0,
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => (await client.query(sql, values)).rows as T,
  };
  return {
    ...raw,
    $transaction: async (fn) => {
      await client.query("BEGIN");
      try {
        const out = await fn(raw);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  };
}

const read = (path: string) => readFileSync(path, "utf8");
const migration = (suffix: string) => {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith(suffix));
  if (!dir) throw new Error(`migration ${suffix} not found`);
  return join(MIGRATIONS, dir);
};
const staged = (suffix: string) => join(STAGED, readdirSync(STAGED).find((d) => d.endsWith(suffix))!);

describeDb("epoch → timestamptz migration phases (Postgres)", () => {
  const schema = `epoch_ts_${Date.now()}`;
  const N_INTENTS = 12_345;
  const N_SOLVERS = 1_234;
  let client: Client;
  let db: SqlClient;

  /** Run a whole migration file as one simple query (= one implicit transaction, like Prisma). */
  const run = (file: string) => client.query(read(file));

  beforeAll(async () => {
    // Explicit fields: pg's connection-string parser does not load under this Jest transform.
    const u = new URL(url!);
    client = new Client({
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
    });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    // Legacy shape: only the columns the migrations touch.
    await client.query(`
      CREATE TABLE intents (
        id text PRIMARY KEY, "user" text NOT NULL, state text NOT NULL, solver text,
        src_verified boolean NOT NULL DEFAULT false, src_token_id text, dst_token_id text,
        created_at integer NOT NULL, deadline integer NOT NULL, filled_at integer);
      CREATE TABLE solvers (
        id text PRIMARY KEY, registered_at integer NOT NULL, last_active_at integer NOT NULL);
      INSERT INTO intents (id, "user", state, created_at, deadline, filled_at)
        SELECT lpad(g::text, 8, '0'), 'G' || (g % 97), CASE WHEN g % 3 = 0 THEN 'filled' ELSE 'open' END,
               1700000000 + g, 1700003600 + g, CASE WHEN g % 3 = 0 THEN 1700001000 + g END
        FROM generate_series(1, ${N_INTENTS}) g;
      INSERT INTO solvers (id, registered_at, last_active_at)
        SELECT lpad(g::text, 8, '0'), 1690000000 + g, 1700000000 + g FROM generate_series(1, ${N_SOLVERS}) g;`);
    db = adapt(client);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  it("phase 1 — expand adds nullable twins; legacy rows start out of sync", async () => {
    await run(join(migration("_epoch_ts_expand"), "migration.sql"));
    expect(await countOutOfSync(db, intents)).toBe(N_INTENTS);
    expect(await countOutOfSync(db, solvers)).toBe(N_SOLVERS);
  });

  it("phase 1 — the sync trigger dual-writes for Int-only and ts-only writers", async () => {
    // An old replica (Int only) inserts and updates.
    await client.query(
      `INSERT INTO intents (id, "user", state, created_at, deadline) VALUES ('zz-old', 'G1', 'open', 1800000000, 1800003600)`,
    );
    await client.query(`UPDATE intents SET deadline = 1800009999, filled_at = 1800005000 WHERE id = 'zz-old'`);
    // A writer that only knows the timestamptz side.
    await client.query(
      `UPDATE intents SET created_at_ts = '2030-01-01T00:00:00Z' WHERE id = 'zz-old'`,
    );
    const { rows } = await client.query(
      `SELECT created_at, deadline_ts, filled_at_ts FROM intents WHERE id = 'zz-old'`,
    );
    expect(rows[0].created_at).toBe(1893456000);
    expect(rows[0].deadline_ts.toISOString()).toBe(new Date(1800009999 * 1000).toISOString());
    expect(rows[0].filled_at_ts.toISOString()).toBe(new Date(1800005000 * 1000).toISOString());
  });

  it("phase 1 — every index migration is a single CONCURRENTLY statement that applies cleanly", async () => {
    const dirs = readdirSync(MIGRATIONS).filter((d) => d.includes("_epoch_ts_idx_"));
    expect(dirs).toHaveLength(9);
    for (const dir of dirs) {
      const sql = read(join(MIGRATIONS, dir, "migration.sql"));
      const statements = sql.replace(/--.*$/gm, "").split(";").filter((s) => s.trim());
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
      await client.query(sql); // outside a transaction, as Prisma runs a one-statement file
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE '%\\_ts\\_idx'`,
      [schema],
    );
    expect(rows[0].n).toBe(9);
  });

  it("phase 3 guard — the staged enforce step refuses to run before the backfill", async () => {
    await expect(run(join(staged("_epoch_ts_not_null_checks"), "migration.sql"))).rejects.toThrow(
      /verification failed/,
    );
  });

  it("phase 2 — backfill is resumable and never holds a batch longer than 1 s", async () => {
    const cursors: string[] = [];
    // Interrupt after the first batch, as a crash or Ctrl-C would.
    await expect(
      backfillTable(db, intents, {
        onBatch: (p) => {
          cursors.push(p.lastId);
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    // The row written after the expand is already in sync; only legacy rows remain.
    expect(await countOutOfSync(db, intents)).toBe(N_INTENTS - MAX_BATCH_SIZE);

    const durations: number[] = [];
    const resumed = await backfillTable(db, intents, {
      startAfterId: cursors[0],
      onBatch: (p) => durations.push(p.ms),
    });
    expect(resumed.scanned).toBe(N_INTENTS + 1 - MAX_BATCH_SIZE);
    expect(Math.max(...durations)).toBeLessThan(1_000);
    await backfillTable(db, solvers);

    expect(await countOutOfSync(db, intents)).toBe(0);
    expect(await countOutOfSync(db, solvers)).toBe(0);
    // A second run finds nothing to write.
    expect((await backfillTable(db, intents)).updated).toBe(0);
  });

  it("phase 2 — timestamptz reads are served by the new indexes", async () => {
    await client.query("ANALYZE intents");
    const { rows } = await client.query(
      `EXPLAIN SELECT id FROM intents WHERE "user" = 'G5' ORDER BY created_at_ts DESC LIMIT 20`,
    );
    expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/intents_user_created_ts_idx/);
  });

  it("phase 3 — staged steps 1–4 enforce NOT NULL and drop the epoch columns", async () => {
    await run(join(staged("_epoch_ts_not_null_checks"), "migration.sql"));
    await run(join(staged("_epoch_ts_validate_checks"), "migration.sql"));
    await run(join(staged("_epoch_ts_set_not_null"), "migration.sql"));
    await run(join(staged("_epoch_ts_contract"), "migration.sql"));

    const { rows } = await client.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND column_name ~ '(created_at|deadline|filled_at|registered_at|last_active_at)'
       ORDER BY 1, 2`,
      [schema],
    );
    expect(rows).toEqual([
      { table_name: "intents", column_name: "created_at_ts", is_nullable: "NO" },
      { table_name: "intents", column_name: "deadline_ts", is_nullable: "NO" },
      { table_name: "intents", column_name: "filled_at_ts", is_nullable: "YES" },
      { table_name: "solvers", column_name: "last_active_at_ts", is_nullable: "NO" },
      { table_name: "solvers", column_name: "registered_at_ts", is_nullable: "NO" },
    ]);
  });

  it("rollback — contract down.sql + reverse backfill restores the epoch values", async () => {
    await run(join(staged("_epoch_ts_contract"), "down.sql"));
    await backfillTable(db, intents, { direction: "to-epoch" });
    await backfillTable(db, solvers, { direction: "to-epoch" });

    expect(await countOutOfSync(db, intents)).toBe(0);
    const { rows } = await client.query(
      `SELECT created_at, deadline, filled_at FROM intents WHERE id IN ('00000003', '00000004') ORDER BY id`,
    );
    expect(rows).toEqual([
      { created_at: 1700000003, deadline: 1700003603, filled_at: 1700001003 },
      { created_at: 1700000004, deadline: 1700003604, filled_at: null },
    ]);
    // The re-created trigger keeps new writes in sync again.
    await client.query(`UPDATE solvers SET last_active_at_ts = '2031-01-01Z' WHERE id = '00000001'`);
    const s = await client.query(`SELECT last_active_at FROM solvers WHERE id = '00000001'`);
    expect(s.rows[0].last_active_at).toBe(1924992000);
  });
});
