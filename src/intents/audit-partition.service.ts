import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { LeaderElectionService, Singleton } from "../common/leader-election";
import { MetricsService } from "../metrics/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { ArchivalS3Client } from "../archival/s3-client";
import { writeAuditParquet } from "../archival/parquet-writer";
import { sha256Hex } from "../archival/archival-manifest";

/** Live table name; partitioned once the staged swap has run. */
export const AUDIT_TABLE = "intent_audit_log";
/** Partitioned shadow table used until the swap (issue #407 phase 1). */
export const AUDIT_SHADOW_TABLE = "intent_audit_log_p";
export const AUDIT_DEFAULT_PARTITION = "intent_audit_log_default";

const PARTITION_RE = /^intent_audit_log_y(\d{4})m(\d{2})$/;
const DETACHED_RE = /^intent_audit_log_detached_y(\d{4})m(\d{2})$/;
const EXPORT_BATCH = 5_000;

/** Where exported partitions go. `ArchivalS3Client` satisfies it. */
export interface AuditArchiveStore {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}
export const AUDIT_ARCHIVE_STORE = Symbol("AUDIT_ARCHIVE_STORE");

/** First instant (UTC) of the month containing `d`, offset by `add` months. */
export function monthStart(d: Date, add = 0): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1));
}

/** `2026-10-…` → `y2026m10`. */
export function monthSuffix(d: Date): string {
  return `y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Parse a partition or detached-table name back to its month start, if it is one. */
export function partitionMonth(name: string): Date | undefined {
  const m = PARTITION_RE.exec(name) ?? DETACHED_RE.exec(name);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : undefined;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface AuditPartitionReport {
  /** Partitioned table being maintained, or null when none exists (no-op). */
  parent: string | null;
  created: string[];
  detached: string[];
  exported: string[];
  dropped: string[];
  errors: string[];
  attached: number;
  monthsAhead: number;
  defaultPartitionRows: number;
}

/**
 * Monthly partition maintenance for `intent_audit_log` (issue #407).
 *
 * Runs on the elected leader (`audit-partitions`) at start-up and every
 * `AUDIT_PARTITION_INTERVAL_MS`:
 *
 * 1. **Create ahead** — the current month and the next
 *    `AUDIT_PARTITION_PREMAKE_MONTHS` months always have a partition, via the
 *    `intent_audit_log_ensure_partition()` SQL function (which also moves any
 *    rows that fell into the default partition).
 * 2. **Retention** — with `AUDIT_RETENTION_MONTHS > 0`, partitions whose month
 *    ended more than that many months ago are detached (plain `DETACH`, since
 *    `DETACH … CONCURRENTLY` is not allowed while a default partition exists;
 *    it is catalog-only and runs under a 1 s lock timeout), renamed to
 *    `intent_audit_log_detached_yYYYYmMM` and their foreign key is dropped so
 *    intent archival can no longer cascade into them.
 * 3. **Export** — when archival is enabled (`ARCHIVAL_*`), each detached table
 *    is written to `audit-partitions/yYYYYmMM/` as Parquet plus a manifest.
 *    Tables are kept unless `AUDIT_RETENTION_DROP_AFTER_EXPORT=true`, and are
 *    only ever dropped after the export's files are confirmed present.
 *
 * Before the staged swap the partitioned table is `intent_audit_log_p`; the
 * service maintains whichever of the two is partitioned and does nothing on a
 * database without either (in-memory dev setups). `pg_partman` can replace
 * steps 1–2 — see RUNBOOK_BACKUP_RESTORE.md.
 */
@Singleton("audit-partitions")
@Injectable()
export class AuditPartitionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditPartitionService.name);
  private interval?: NodeJS.Timeout;
  private running?: Promise<AuditPartitionReport>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() private readonly leaderElection?: LeaderElectionService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @Inject(AUDIT_ARCHIVE_STORE) private readonly archiveStore?: AuditArchiveStore,
  ) {}

  onModuleInit(): void {
    if (!this.settings().maintenanceEnabled || !this.leaderElection) return;
    this.leaderElection.registerWorker("audit-partitions", (isLeader) => {
      if (isLeader) this.start();
      else this.stop();
    });
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** One maintenance pass. Concurrent calls share the in-flight pass. */
  run(now: Date = new Date()): Promise<AuditPartitionReport> {
    this.running ??= this.execute(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private start(): void {
    if (this.interval) return;
    const tick = () =>
      void this.run().catch((err: unknown) =>
        this.logger.warn(`[audit-partitions] maintenance failed: ${(err as Error).message}`),
      );
    tick();
    this.interval = setInterval(tick, this.settings().intervalMs);
    this.interval.unref?.();
  }

  private stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private async execute(now: Date): Promise<AuditPartitionReport> {
    const report: AuditPartitionReport = {
      parent: null,
      created: [],
      detached: [],
      exported: [],
      dropped: [],
      errors: [],
      attached: 0,
      monthsAhead: 0,
      defaultPartitionRows: 0,
    };
    const parent = await this.resolveParent();
    report.parent = parent;
    if (!parent) return report;

    await this.ensureUpcoming(parent, now, report);
    if (this.settings().retentionMonths > 0) await this.applyRetention(parent, now, report);
    await this.exportDetached(report);

    const attached = await this.attachedMonths(parent);
    report.attached = attached.length;
    report.monthsAhead = this.monthsAhead(attached, now);
    report.defaultPartitionRows = await this.defaultRows();
    const detachedCount = (await this.detachedTables()).length;
    this.metrics?.setAuditPartitionState(report.attached, detachedCount, report.monthsAhead, report.defaultPartitionRows);
    if (report.defaultPartitionRows > 0) {
      this.logger.warn(
        `[audit-partitions] ${report.defaultPartitionRows} row(s) in ${AUDIT_DEFAULT_PARTITION} — a month had no partition`,
      );
    }
    return report;
  }

  /** The partitioned audit table in the current schema, preferring the live name. */
  async resolveParent(): Promise<string | null> {
    // Test doubles without raw SQL have no partitions to maintain.
    if (typeof (this.prisma as { $queryRawUnsafe?: unknown }).$queryRawUnsafe !== "function") return null;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname FROM pg_partitioned_table p
         JOIN pg_class c ON c.oid = p.partrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname IN ($1, $2)
        ORDER BY (c.relname = $1) DESC
        LIMIT 1`,
      AUDIT_TABLE,
      AUDIT_SHADOW_TABLE,
    );
    return rows[0]?.relname ?? null;
  }

  private async ensureUpcoming(parent: string, now: Date, report: AuditPartitionReport): Promise<void> {
    const existing = new Set((await this.attachedMonths(parent)).map((d) => d.getTime()));
    for (let i = 0; i <= this.settings().premakeMonths; i++) {
      const month = monthStart(now, i);
      if (existing.has(month.getTime())) continue;
      try {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ part: string }>>(
          `SELECT "intent_audit_log_ensure_partition"($1::regclass, $2::date) AS part`,
          q(parent),
          month.toISOString().slice(0, 10),
        );
        report.created.push(rows[0]?.part ?? `intent_audit_log_${monthSuffix(month)}`);
        this.metrics?.incAuditPartitionOp("create", "success");
      } catch (err) {
        this.metrics?.incAuditPartitionOp("create", "failed");
        report.errors.push(`create ${monthSuffix(month)}: ${(err as Error).message}`);
      }
    }
  }

  private async applyRetention(parent: string, now: Date, report: AuditPartitionReport): Promise<void> {
    // A partition is expired once its whole month lies before the cutoff.
    const cutoff = monthStart(now, -this.settings().retentionMonths);
    for (const month of await this.attachedMonths(parent)) {
      if (month.getTime() >= cutoff.getTime()) continue;
      const part = `intent_audit_log_${monthSuffix(month)}`;
      const detached = `intent_audit_log_detached_${monthSuffix(month)}`;
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`);
          await tx.$executeRawUnsafe(`ALTER TABLE ${q(parent)} DETACH PARTITION ${q(part)}`);
          await tx.$executeRawUnsafe(`ALTER TABLE ${q(part)} RENAME TO ${q(detached)}`);
          const fks = await tx.$queryRawUnsafe<Array<{ conname: string }>>(
            `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`,
            q(detached),
          );
          for (const { conname } of fks) {
            await tx.$executeRawUnsafe(`ALTER TABLE ${q(detached)} DROP CONSTRAINT ${q(conname)}`);
          }
        });
        report.detached.push(detached);
        this.metrics?.incAuditPartitionOp("detach", "success");
        this.logger.log(`[audit-partitions] detached ${part} → ${detached}`);
      } catch (err) {
        this.metrics?.incAuditPartitionOp("detach", "failed");
        report.errors.push(`detach ${part}: ${(err as Error).message}`);
      }
    }
  }

  /** Export every detached table that has no manifest yet; optionally drop it. */
  private async exportDetached(report: AuditPartitionReport): Promise<void> {
    const store = this.store();
    if (!store) return;
    for (const table of await this.detachedTables()) {
      const suffix = monthSuffix(partitionMonth(table)!);
      const prefix = `audit-partitions/${suffix}`;
      const manifestKey = `${prefix}/manifest.json`;
      try {
        let manifest: { files: Array<{ key: string }> } | undefined;
        if (!(await store.exists(manifestKey))) {
          manifest = await this.exportTable(store, table, prefix);
          await store.put(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
          report.exported.push(table);
          this.metrics?.incAuditPartitionOp("export", "success");
        }
        if (this.settings().dropAfterExport) {
          await this.dropIfExported(store, table, manifestKey, manifest, report);
        }
      } catch (err) {
        this.metrics?.incAuditPartitionOp("export", "failed");
        report.errors.push(`export ${table}: ${(err as Error).message}`);
      }
    }
  }

  private async exportTable(store: AuditArchiveStore, table: string, prefix: string) {
    const files: Array<{ key: string; type: "audit"; rowCount: number; sha256: string; sizeBytes: number }> = [];
    let cursor = "0";
    for (let index = 0; ; index++) {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ id: bigint; intent_id: string; timestamp: Date; to_state: string; actor: string; reason: string; metadata: unknown }>
      >(
        `SELECT "id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata"
           FROM ${q(table)} WHERE "id" > $1::bigint ORDER BY "id" LIMIT ${EXPORT_BATCH}`,
        cursor,
      );
      if (rows.length === 0) break;
      const buf = await writeAuditParquet(
        rows.map((r) => ({
          id: r.id,
          intent_id: r.intent_id,
          timestamp: r.timestamp.toISOString(),
          to_state: r.to_state,
          actor: r.actor,
          reason: r.reason,
          metadata: r.metadata ? JSON.stringify(r.metadata) : null,
        })),
      );
      const key = `${prefix}/part-${String(index).padStart(5, "0")}.parquet`;
      await store.put(key, buf, "application/octet-stream");
      files.push({ key, type: "audit", rowCount: rows.length, sha256: sha256Hex(buf), sizeBytes: buf.length });
      cursor = rows[rows.length - 1].id.toString();
      if (rows.length < EXPORT_BATCH) break;
    }
    return {
      table,
      exportedAt: new Date().toISOString(),
      totalRows: files.reduce((n, f) => n + f.rowCount, 0),
      files,
    };
  }

  private async dropIfExported(
    store: AuditArchiveStore,
    table: string,
    manifestKey: string,
    manifest: { files: Array<{ key: string }> } | undefined,
    report: AuditPartitionReport,
  ): Promise<void> {
    // Re-check what is actually in the bucket before deleting anything.
    if (!(await store.exists(manifestKey))) return;
    for (const file of manifest?.files ?? []) {
      if (!(await store.exists(file.key))) return;
    }
    try {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${q(table)}`);
      report.dropped.push(table);
      this.metrics?.incAuditPartitionOp("drop", "success");
    } catch (err) {
      this.metrics?.incAuditPartitionOp("drop", "failed");
      report.errors.push(`drop ${table}: ${(err as Error).message}`);
    }
  }

  // ── Catalog helpers ─────────────────────────────────────────────────────────

  /** Months that currently have an attached partition, ascending. */
  async attachedMonths(parent: string): Promise<Date[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = $1::regclass`,
      q(parent),
    );
    return rows
      .map((r) => (PARTITION_RE.test(r.relname) ? partitionMonth(r.relname) : undefined))
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => a.getTime() - b.getTime());
  }

  private async detachedTables(): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname LIKE 'intent\\_audit\\_log\\_detached\\_y%'
        ORDER BY c.relname`,
    );
    return rows.map((r) => r.relname).filter((n) => DETACHED_RE.test(n));
  }

  /** Rows in the default partition, capped at 100k (only "is it non-zero" matters). */
  private async defaultRows(): Promise<number> {
    const exists = await this.prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT to_regclass($1) IS NOT NULL AS ok`,
      q(AUDIT_DEFAULT_PARTITION),
    );
    if (!exists[0]?.ok) return 0;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${q(AUDIT_DEFAULT_PARTITION)} LIMIT 100000) s`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Consecutive months after the current one that have a partition. */
  private monthsAhead(attached: Date[], now: Date): number {
    const have = new Set(attached.map((d) => d.getTime()));
    let n = 0;
    while (have.has(monthStart(now, n + 1).getTime())) n++;
    return n;
  }

  private store(): AuditArchiveStore | undefined {
    if (this.archiveStore) return this.archiveStore;
    const archival = this.config.get("archival", { infer: true });
    return archival?.enabled ? new ArchivalS3Client(archival) : undefined;
  }

  private settings(): AppConfig["auditPartition"] {
    return this.config.get("auditPartition", { infer: true });
  }
}
