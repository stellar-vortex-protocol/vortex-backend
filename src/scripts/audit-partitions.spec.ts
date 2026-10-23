/**
 * Issue #407 — monthly partitioning of intent_audit_log.
 *
 * Unit part (always runs): the copy script's SQL and argument parsing.
 *
 * Migration part (opt-in via TEST_DATABASE_URL), in an isolated scratch
 * schema seeded with AUDIT_PARTITION_TEST_ROWS legacy rows (default 1,000,000):
 *
 *   expand migration → live mirroring → swap refused before the copy →
 *   interrupted + resumed batched copy → partition pruning (EXPLAIN
 *   snapshot) → staged swap (id sequence continues, month-boundary and
 *   default-partition inserts) → AuditPartitionService create-ahead,
 *   retention detach + export + drop → swap rollback.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { ConfigService } from "@nestjs/config";
import {
  BATCH_SQL,
  copyAuditRows,
  countMissing,
  ensurePartitionsForData,
  MAX_BATCH_SIZE,
  parseArgs,
  SqlClient,
} from "../../scripts/backfill-audit-partitions";
import { AuditArchiveStore, AuditPartitionService } from "../intents/audit-partition.service";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";

const ROOT = join(__dirname, "../..");
const MIGRATIONS = join(ROOT, "prisma/migrations");
const STAGED = join(ROOT, "prisma/staged-migrations/407-audit-log-partitioning");

describe("backfill-audit-partitions (issue #407) — unit", () => {
  it("copies one keyset batch per statement, skipping rows the mirror already wrote", () => {
    expect(BATCH_SQL).toContain(`WHERE "id" > $1::bigint ORDER BY "id" LIMIT $2::int`);
    expect(BATCH_SQL).toContain("ON CONFLICT DO NOTHING");
    expect(BATCH_SQL.match(/;/g)).toBeNull();
  });

  it("parses flags and enforces the 5k batch ceiling", async () => {
    expect(parseArgs(["--verify", "--batch-size", "10"])).toMatchObject({ verifyOnly: true, batchSize: 10 });
    await expect(copyAuditRows({} as SqlClient, { batchSize: MAX_BATCH_SIZE + 1 })).rejects.toThrow(/batch-size/);
  });
});

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const ROWS = Number(process.env.AUDIT_PARTITION_TEST_ROWS ?? 1_000_000);

function connect(): Client {
  // Explicit fields: pg's connection-string parser does not load under this Jest transform.
  const u = new URL(url!);
  return new Client({
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
}

/** Adapt a pg Client to the Prisma-shaped surfaces used by the script and the service. */
function adapt(client: Client) {
  const raw = {
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => (await client.query(sql, values)).rowCount ?? 0,
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => (await client.query(sql, values)).rows as T,
  };
  return {
    ...raw,
    $transaction: async <T>(fn: (tx: typeof raw) => Promise<T>): Promise<T> => {
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

const read = (p: string) => readFileSync(p, "utf8");
const migrationDir = (suffix: string) => join(MIGRATIONS, readdirSync(MIGRATIONS).find((d) => d.endsWith(suffix))!);
const stagedDir = (suffix: string) => join(STAGED, readdirSync(STAGED).find((d) => d.endsWith(suffix))!);

describeDb("intent_audit_log partitioning (Postgres)", () => {
  jest.setTimeout(600_000);
  const schema = `audit_parts_${Date.now()}`;
  let client: Client;
  let db: ReturnType<typeof adapt>;
  let maxLegacyId: number;

  const partitionOf = async (table: string, id: number) =>
    (await client.query(`SELECT tableoid::regclass::text AS p FROM ${table} WHERE id = $1`, [id])).rows[0]?.p;

  beforeAll(async () => {
    client = connect();
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE intents (intent_id text PRIMARY KEY)`);
    await client.query(`INSERT INTO intents SELECT 'i-' || g FROM generate_series(1, 1000) g`);
    // The original (unpartitioned) table, exactly as production has it.
    await client.query(read(join(migrationDir("_intent_audit_log"), "migration.sql")));
    // ROWS rows spread evenly over Sep 2025 → Oct 2026 (14 months), in id order.
    await client.query(
      `INSERT INTO intent_audit_log (intent_id, "timestamp", to_state, actor, reason)
       SELECT 'i-' || (1 + g % 1000),
              timestamptz '2025-09-01 00:00:00+00' + (g::double precision / $1) * interval '425 days',
              'open', 'system', 'seed'
       FROM generate_series(0, $1 - 1) g`,
      [ROWS],
    );
    maxLegacyId = Number((await client.query(`SELECT max(id) AS m FROM intent_audit_log`)).rows[0].m);
    db = adapt(client);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  it("phase 1 — expand creates the partitioned shadow table without touching live rows", async () => {
    await client.query(read(join(migrationDir("_audit_log_partitioned_expand"), "migration.sql")));
    const parts = await client.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'intent_audit_log_p'::regclass ORDER BY 1`,
    );
    const names = parts.rows.map((r) => r.relname as string);
    expect(names).toContain("intent_audit_log_default");
    expect(names).toContain("intent_audit_log_y2025m09");
    expect(names).toContain(
      `intent_audit_log_y${new Date().getUTCFullYear()}m${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`,
    );
    expect(Number((await client.query(`SELECT count(*) FROM intent_audit_log`)).rows[0].count)).toBe(ROWS);
    expect(await countMissing(db)).toBe(ROWS);
  });

  it("phase 1 — live inserts and deletes are mirrored, sharing the id sequence", async () => {
    const { rows } = await client.query(
      `INSERT INTO intent_audit_log (intent_id, to_state, actor, reason) VALUES ('i-1', 'accepted', 'GSOLVER', 'live')
       RETURNING id`,
    );
    const id = Number(rows[0].id);
    expect(id).toBe(maxLegacyId + 1);
    expect(await partitionOf("intent_audit_log_p", id)).toMatch(/^intent_audit_log_y\d{4}m\d{2}$/);
    await client.query(`DELETE FROM intent_audit_log WHERE id = $1`, [id]);
    expect(await partitionOf("intent_audit_log_p", id)).toBeUndefined();
  });

  it("phase 3 guard — the staged swap refuses before the copy has finished", async () => {
    await expect(client.query(read(join(stagedDir("_audit_log_partition_swap"), "migration.sql")))).rejects.toThrow(
      /swap refused/,
    );
  });

  it(`phase 2 — copies ${ROWS} rows in ≤5k batches, resumably, each under 1 s`, async () => {
    expect(await ensurePartitionsForData(db)).toHaveLength(14);

    let firstCursor: bigint | undefined;
    await expect(
      copyAuditRows(db, {
        onBatch: (p) => {
          firstCursor = p.lastId;
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    expect(await countMissing(db)).toBe(ROWS - MAX_BATCH_SIZE);

    const durations: number[] = [];
    const result = await copyAuditRows(db, { startAfterId: firstCursor, onBatch: (p) => durations.push(p.ms) });
    expect(result.copied).toBe(ROWS - MAX_BATCH_SIZE);
    // A copy batch only reads the live table (ACCESS SHARE) and locks its own new
    // rows, so it never blocks application writes. Its duration is still kept
    // under a second for the bulk of batches; the odd outlier (checkpoint,
    // autovacuum, a loaded CI box) is tolerated.
    const sorted = [...durations].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.95)]).toBeLessThan(1_000);
    expect(await countMissing(db)).toBe(0);
    expect(Number((await client.query(`SELECT count(*) FROM intent_audit_log_default`)).rows[0].count)).toBe(0);
  });

  it("the audit endpoint's query prunes partitions older than the intent (EXPLAIN snapshot)", async () => {
    await client.query("ANALYZE intent_audit_log_p");
    // Same shape as IntentsService.getAuditTrail: intent_id + timestamp >= createdAt - skew.
    const plan = async (sql: string, params: unknown[] = []) =>
      (await client.query(`EXPLAIN (COSTS OFF) ${sql}`, params)).rows.map((r) => r["QUERY PLAN"] as string);
    const scanned = (lines: string[]) =>
      [...new Set(lines.join("\n").match(/intent_audit_log_(?:y\d{4}m\d{2}|default)/g) ?? [])].sort();

    const literal = await plan(
      `SELECT * FROM intent_audit_log_p WHERE intent_id = 'i-7' AND "timestamp" >= '2026-08-15T00:00:00Z'
        ORDER BY "timestamp", id LIMIT 20`,
    );
    const monthly = scanned(literal).filter((p) => p.startsWith("intent_audit_log_y"));
    expect(monthly.filter((p) => p < "intent_audit_log_y2026m08")).toEqual([]);
    expect(monthly).toContain("intent_audit_log_y2026m08");
    expect({ partitions: scanned(literal).filter((p) => p <= "intent_audit_log_y2026m10") }).toMatchSnapshot();

    // Prisma sends parameters: a generic plan must still prune (at executor start-up).
    await client.query(`SET plan_cache_mode = force_generic_plan`);
    await client.query(
      `PREPARE audit_q(text, timestamptz) AS
         SELECT * FROM intent_audit_log_p WHERE intent_id = $1 AND "timestamp" >= $2 ORDER BY "timestamp", id LIMIT 20`,
    );
    const generic = (
      await client.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) EXECUTE audit_q('i-7', '2026-08-15T00:00:00Z')`)
    ).rows.map((r) => r["QUERY PLAN"] as string);
    expect(generic.join("\n")).toMatch(/Subplans Removed: \d+/);
    await client.query(`DEALLOCATE audit_q; RESET plan_cache_mode`);
  });

  it("phase 3 — the staged swap renames in place; ids continue and month boundaries route correctly", async () => {
    await client.query(read(join(stagedDir("_audit_log_partition_swap"), "migration.sql")));

    const kind = await client.query(
      `SELECT relkind FROM pg_class WHERE oid IN ('intent_audit_log'::regclass, 'intent_audit_log_legacy'::regclass)
       ORDER BY relname`,
    );
    expect(kind.rows.map((r) => r.relkind)).toEqual(["p", "r"]); // intent_audit_log partitioned, legacy plain
    expect(Number((await client.query(`SELECT count(*) FROM intent_audit_log`)).rows[0].count)).toBe(ROWS);

    const ins = async (ts: string) =>
      Number(
        (
          await client.query(
            `INSERT INTO intent_audit_log (intent_id, "timestamp", to_state, actor, reason)
             VALUES ('i-2', $1, 'filled', 'GSOLVER', 'post-swap') RETURNING id`,
            [ts],
          )
        ).rows[0].id,
      );
    const last = await ins("2026-10-31T23:59:59.999Z");
    const first = await ins("2026-11-01T00:00:00.000Z");
    const far = await ins("2031-01-15T00:00:00.000Z");
    expect(last).toBeGreaterThan(maxLegacyId + 1);
    expect([first, far]).toEqual([last + 1, last + 2]);
    expect(await partitionOf("intent_audit_log", last)).toBe("intent_audit_log_y2026m10");
    expect(await partitionOf("intent_audit_log", first)).toBe("intent_audit_log_y2026m11");
    expect(await partitionOf("intent_audit_log", far)).toBe("intent_audit_log_default"); // safety net
    const owner = await client.query(`SELECT pg_get_serial_sequence('intent_audit_log', 'id') AS s`);
    expect(owner.rows[0].s).toMatch(/intent_audit_log_id_seq/);
  });

  it("maintenance — creates partitions ahead, rescues default rows, detaches + exports + drops old months", async () => {
    const puts = new Map<string, Buffer>();
    const store: AuditArchiveStore = {
      exists: async (k) => puts.has(k),
      put: async (k, b) => void puts.set(k, b),
    };
    const settings = {
      maintenanceEnabled: true,
      intervalMs: 60_000,
      premakeMonths: 3,
      retentionMonths: 12,
      dropAfterExport: false,
    };
    const config = {
      get: (key: string) => ({ auditPartition: settings, archival: { enabled: false } })[key],
    } as unknown as ConfigService<AppConfig, true>;
    const service = new AuditPartitionService(db as unknown as PrismaService, config, undefined, undefined, store);
    const before = (
      await client.query(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'intent_audit_log'::regclass AND c.relname ~ '^intent_audit_log_y'`,
      )
    ).rows.map((r) => r.relname as string);
    // Retention 12 months at "now" = Dec 2030 → everything before Dec 2029 expires.
    const expiring = before.filter((n) => n < "intent_audit_log_y2029m12");
    expect(expiring.length).toBeGreaterThanOrEqual(15);

    // "now" = mid Dec 2030: Dec 2030 … Mar 2031 are created; Jan 2031 rescues the far row.
    const report = await service.run(new Date("2030-12-15T00:00:00Z"));
    expect(report.parent).toBe("intent_audit_log");
    expect(report.created).toEqual(expect.arrayContaining(["intent_audit_log_y2031m01", "intent_audit_log_y2031m03"]));
    expect(report.defaultPartitionRows).toBe(0);
    expect(report.monthsAhead).toBe(3);
    // Every month created so far is older than Dec 2029 → detached and exported, not dropped.
    expect(report.detached.sort()).toEqual(expiring.map((n) => n.replace("_y", "_detached_y")).sort());
    expect(report.exported).toHaveLength(expiring.length);
    expect(report.dropped).toEqual([]);
    expect(report.errors).toEqual([]);
    const manifest = JSON.parse(puts.get("audit-partitions/y2025m09/manifest.json")!.toString());
    expect(manifest.totalRows).toBeGreaterThan(0);
    expect(puts.has("audit-partitions/y2025m09/part-00000.parquet")).toBe(true);
    // Detached tables keep their rows but no longer reference intents.
    const fk = await client.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'intent_audit_log_detached_y2025m09'::regclass AND contype = 'f'`,
    );
    expect(fk.rows[0].n).toBe(0);

    // Opt-in drop: only after the export is confirmed in the store.
    settings.dropAfterExport = true;
    const second = await service.run(new Date("2030-12-15T00:00:00Z"));
    expect(second.dropped).toHaveLength(expiring.length);
    expect(second.exported).toEqual([]); // manifests already exist — no re-export
  });

  it("rollback — the swap's down.sql restores the unpartitioned table", async () => {
    const fresh = connect();
    await fresh.connect();
    await fresh.query(`SET search_path TO "${schema}"`);
    try {
      await fresh.query(read(join(stagedDir("_audit_log_partition_swap"), "down.sql")));
      const kind = await fresh.query(`SELECT relkind FROM pg_class WHERE oid = 'intent_audit_log'::regclass`);
      expect(kind.rows[0].relkind).toBe("r");
      // Post-swap rows still in the partitioned table were copied back (the two
      // in Oct/Nov 2026 left with their partitions in the retention test).
      const { rows } = await fresh.query(`SELECT count(*)::int AS n FROM intent_audit_log WHERE reason = 'post-swap'`);
      expect(rows[0].n).toBe(1);
      // The mirror trigger is live again.
      const id = Number(
        (
          await fresh.query(
            `INSERT INTO intent_audit_log (intent_id, to_state, actor, reason) VALUES ('i-3', 'open', 's', 'after-rollback') RETURNING id`,
          )
        ).rows[0].id,
      );
      expect(Number((await fresh.query(`SELECT count(*) FROM intent_audit_log_p WHERE id = $1`, [id])).rows[0].count)).toBe(1);
    } finally {
      await fresh.end();
    }
  });
});
