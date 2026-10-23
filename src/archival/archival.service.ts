import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { epochToDate, readEpoch } from "../prisma/epoch-timestamps";
import { ArchivalConfig } from "./archival-config";
import { ArchivalS3Client } from "./s3-client";
import {
  writeIntentsParquet,
  writeAuditParquet,
  readParquetFromBuffer,
} from "./parquet-writer";
import {
  ArchivalManifest,
  ManifestFile,
  sha256Hex,
  verifyManifest,
} from "./archival-manifest";

/**
 * Result of one archival run.
 */
export interface ArchivalRunResult {
  date: string;
  skipped: boolean;
  intentRowsArchived: number;
  auditRowsArchived: number;
  intentRowsDeleted: number;
  auditRowsDeleted: number;
  durationMs: number;
  manifestKey: string | null;
}

/**
 * Options for {@link ArchivalService.restoreDate}.
 */
export interface RestoreOptions {
  /** Target Postgres schema for the imported rows. */
  schema: string;
  /** When true, verify + read everything but write nothing to Postgres. */
  dryRun: boolean;
}

/**
 * Result of one archival restore.
 */
export interface RestoreResult {
  date: string;
  schema: string;
  dryRun: boolean;
  intentRowsImported: number;
  intentRowsRestored: number;
  auditRowsImported: number;
  rowsImported: number;
  filesProcessed: number;
  filesVerified: number;
  durationMs: number;
  manifestKey: string;
}

/**
 * ArchivalService (#413).
 *
 * Exports terminal intents (filled / cancelled / expired / slashed) that are
 * older than `retentionDays` to partitioned Parquet files in S3-compatible
 * storage, then deletes them from Postgres ONLY after verifying the upload.
 *
 * Design principles:
 *   - Streaming export: rows are fetched in cursor-based batches so a 1M-row
 *     day never loads all data into memory at once.
 *   - Idempotent: if the manifest already exists in S3 for a date, the job
 *     skips the export rather than re-running it.
 *   - Safe deletion: rows are deleted from Postgres only after the manifest
 *     checksum passes verification.  A failed upload / verify never deletes.
 *   - Audit entries go with their intents so the export is self-contained.
 */
@Injectable()
export class ArchivalService {
  private readonly logger = new Logger(ArchivalService.name);
  private readonly archivalConfig: ArchivalConfig;
  private readonly s3: ArchivalS3Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {
    this.archivalConfig = this.configService.get("archival", { infer: true });
    this.s3 = new ArchivalS3Client(this.archivalConfig);
  }

  /**
   * Archive all eligible intents for `date` (ISO-8601, YYYY-MM-DD).
   *
   * - Eligible: terminal state AND `created_at` falls within the date AND
   *   `created_at` is older than `retentionDays` days.
   * - Idempotent: if a manifest for `date` already exists in S3, the run is
   *   skipped immediately.
   *
   * @param date  The partition date, e.g. "2026-09-01".
   * @returns     A summary of what was exported and deleted.
   */
  async archiveDate(date: string): Promise<ArchivalRunResult> {
    const start = Date.now();
    const manifestKey = this.manifestKey(date);

    // Idempotency check — skip if already archived.
    if (await this.s3.exists(manifestKey)) {
      this.logger.log(`[archival] ${date}: manifest already exists — skipping`);
      return {
        date,
        skipped: true,
        intentRowsArchived: 0,
        auditRowsArchived: 0,
        intentRowsDeleted: 0,
        auditRowsDeleted: 0,
        durationMs: Date.now() - start,
        manifestKey,
      };
    }

    this.logger.log(`[archival] ${date}: starting export`);

    const { from, to } = this.dateBounds(date);
    const terminalStates = ["filled", "cancelled", "expired", "slashed"];

    // ── Step 1: cursor-based export of intents ───────────────────────────────
    const manifest: ArchivalManifest = {
      date,
      archivedAt: new Date().toISOString(),
      files: [],
      totalIntentRows: 0,
      totalAuditRows: 0,
    };

    const intentIds: string[] = [];
    const allIntentFiles: ManifestFile[] = [];

    let cursor: string | undefined;
    let fileIndex = 0;

    for (;;) {
      const batch = await this.prisma.withStatsTimeout((tx) =>
        (tx as unknown as typeof this.prisma).intent.findMany({
          where: {
            state: { in: terminalStates as never[] },
            // Issue #409: filter on the configured timestamp column.
            ...(this.readsTimestamptz()
              ? { createdAtTs: { gte: epochToDate(from), lt: epochToDate(to) } }
              : { createdAt: { gte: from, lt: to } }),
          },
          orderBy: { intentId: "asc" },
          take: this.archivalConfig.maxRowsPerFile,
          ...(cursor ? { cursor: { intentId: cursor }, skip: 1 } : {}),
          select: {
            intentId: true,
            user: true,
            srcChain: true,
            srcToken: true,
            srcAmount: true,
            dstToken: true,
            minDstAmount: true,
            quotedDstAmount: true,
            acceptedDstAmount: true,
            fillAmount: true,
            feeAmount: true,
            solver: true,
            state: true,
            createdAt: true,
            deadline: true,
            filledAt: true,
            createdAtTs: true,
            deadlineTs: true,
            filledAtTs: true,
            slashedAt: true,
            slashReason: true,
            txHash: true,
            version: true,
            srcVerified: true,
            srcTokenId: true,
            dstTokenId: true,
            srcDecimals: true,
            dstDecimals: true,
          },
        }),
      );

      if (batch.length === 0) break;

      // Convert to Parquet-safe rows.
      const rows = batch.map((r) => {
        const source = this.readSource();
        const filledAt = readEpoch(source, r.filledAt, r.filledAtTs);
        return {
          intent_id: r.intentId,
          user: r.user,
          src_chain: String(r.srcChain),
          src_token: JSON.stringify(r.srcToken),
          src_amount: r.srcAmount,
          dst_token: JSON.stringify(r.dstToken),
          min_dst_amount: r.minDstAmount,
          quoted_dst_amount: r.quotedDstAmount ?? null,
          accepted_dst_amount: r.acceptedDstAmount ?? null,
          fill_amount: r.fillAmount ?? null,
          fee_amount: r.feeAmount ?? null,
          solver: r.solver ?? null,
          state: String(r.state),
          created_at: BigInt(readEpoch(source, r.createdAt, r.createdAtTs) ?? r.createdAt),
          deadline: BigInt(readEpoch(source, r.deadline, r.deadlineTs) ?? r.deadline),
          filled_at: filledAt !== null ? BigInt(filledAt) : null,
          slashed_at: r.slashedAt != null ? BigInt(r.slashedAt) : null,
          slash_reason: r.slashReason ?? null,
          tx_hash: r.txHash ?? null,
          version: r.version,
          src_verified: r.srcVerified,
          src_token_id: r.srcTokenId ?? null,
          dst_token_id: r.dstTokenId ?? null,
          src_decimals: r.srcDecimals ?? null,
          dst_decimals: r.dstDecimals ?? null,
        };
      });

      const parquetBuffer = await writeIntentsParquet(rows);
      const key = this.intentFileKey(date, fileIndex++);
      const checksum = sha256Hex(parquetBuffer);

      await this.s3.put(key, parquetBuffer, "application/octet-stream");

      allIntentFiles.push({
        key,
        type: "intents",
        rowCount: batch.length,
        sha256: checksum,
        sizeBytes: parquetBuffer.length,
      });
      intentIds.push(...batch.map((r) => r.intentId));
      manifest.totalIntentRows += batch.length;

      cursor = batch[batch.length - 1].intentId;
      if (batch.length < this.archivalConfig.maxRowsPerFile) break;
    }

    // ── Step 2: export corresponding audit entries ────────────────────────────
    const auditFiles: ManifestFile[] = [];
    if (intentIds.length > 0) {
      const batchSize = 5000;
      let auditCursor = 0n;
      let auditFileIndex = 0;

      for (;;) {
        const auditBatch = await this.prisma.withStatsTimeout((tx) =>
          (tx as unknown as typeof this.prisma).intentAuditLog.findMany({
            where: {
              intentId: { in: intentIds },
              id: { gt: auditCursor },
            },
            orderBy: { id: "asc" },
            take: batchSize,
          }),
        );

        if (auditBatch.length === 0) break;

        const auditRows = auditBatch.map((a) => ({
          id: a.id,
          intent_id: a.intentId,
          timestamp: a.timestamp.toISOString(),
          to_state: a.toState,
          actor: a.actor,
          reason: a.reason,
          metadata: a.metadata ? JSON.stringify(a.metadata) : null,
        }));

        const buf = await writeAuditParquet(auditRows);
        const key = this.auditFileKey(date, auditFileIndex++);
        const checksum = sha256Hex(buf);

        await this.s3.put(key, buf, "application/octet-stream");
        auditFiles.push({ key, type: "audit", rowCount: auditBatch.length, sha256: checksum, sizeBytes: buf.length });
        manifest.totalAuditRows += auditBatch.length;

        auditCursor = auditBatch[auditBatch.length - 1].id;
        if (auditBatch.length < batchSize) break;
      }
    }

    manifest.files = [...allIntentFiles, ...auditFiles];

    // ── Step 3: write manifest ────────────────────────────────────────────────
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
    await this.s3.put(manifestKey, manifestBuffer, "application/json");

    // ── Step 4: verify uploads before any deletion ────────────────────────────
    await verifyManifest(manifest, (key) => this.s3.get(key));
    this.logger.log(`[archival] ${date}: verification passed (${manifest.totalIntentRows} intents, ${manifest.totalAuditRows} audit entries)`);

    // ── Step 5: delete from Postgres ──────────────────────────────────────────
    // Audit entries are deleted first (FK to intents); then intents.
    let auditDeleted = 0;
    let intentDeleted = 0;

    if (intentIds.length > 0) {
      // Batch deletes to avoid massive single transactions.
      const batchSize = 1000;
      for (let i = 0; i < intentIds.length; i += batchSize) {
        const batch = intentIds.slice(i, i + batchSize);
        const { count: ac } = await this.prisma.intentAuditLog.deleteMany({
          where: { intentId: { in: batch } },
        });
        const { count: ic } = await this.prisma.intent.deleteMany({
          where: { intentId: { in: batch } },
        });
        auditDeleted += ac;
        intentDeleted += ic;
      }
    }

    const durationMs = Date.now() - start;
    this.logger.log(
      `[archival] ${date}: done — archived=${intentDeleted} intents, ` +
      `audit=${auditDeleted}, duration=${durationMs}ms`,
    );

    return {
      date,
      skipped: false,
      intentRowsArchived: manifest.totalIntentRows,
      auditRowsArchived: manifest.totalAuditRows,
      intentRowsDeleted: intentDeleted,
      auditRowsDeleted: auditDeleted,
      durationMs,
      manifestKey,
    };
  }

  /**
   * Restore an archived partition for `date` into a staging schema.
   *
   * Ports the logic of `scripts/restore-archive.ts` (kept as a break-glass
   * fallback) into the service so restores can run as a tracked background
   * job via the admin API.
   *
   * Steps: fetch manifest → download each file → checksum-verify →
   * (unless dryRun) create staging schema/tables → import rows with
   * `ON CONFLICT ... DO NOTHING` (idempotent, safe under concurrency).
   *
   * @throws Error if no manifest exists for `date` in S3.
   */
  async restoreDate(date: string, opts: RestoreOptions): Promise<RestoreResult> {
    const start = Date.now();
    const { schema, dryRun } = opts;
    const manifestKey = this.manifestKey(date);

    if (!(await this.s3.exists(manifestKey))) {
      throw new Error(
        `[archival] restore ${date}: no manifest found at s3://${manifestKey} — nothing to restore`,
      );
    }

    this.logger.log(
      `[archival] restore ${date}: starting (schema=${schema}, dryRun=${dryRun})`,
    );

    // ── Step 1: fetch + parse manifest ───────────────────────────────────────
    const manifestBuffer = await this.s3.get(manifestKey);
    const manifest = JSON.parse(manifestBuffer.toString("utf-8")) as ArchivalManifest;

    // ── Step 2: verify checksums before touching Postgres ────────────────────
    await verifyManifest(manifest, (key) => this.s3.get(key));
    this.logger.log(`[archival] restore ${date}: manifest verification passed`);

    // ── Step 3: prepare staging schema (skipped on dry-run) ──────────────────
    if (!dryRun) {
      await this.ensureRestoreSchema(schema);
    }

    // ── Step 4: import files ─────────────────────────────────────────────────
    let intentRowsImported = 0;
    let auditRowsImported = 0;

    for (const file of manifest.files) {
      const buffer = await this.s3.get(file.key);
      const actual = sha256Hex(buffer);
      if (actual !== file.sha256) {
        throw new Error(
          `[archival] restore ${date}: checksum mismatch for ${file.key} ` +
            `(expected ${file.sha256}, got ${actual}) — aborting`,
        );
      }

      const rows = await readParquetFromBuffer(buffer);
      const kind = file.type ?? file.kind;

      if (kind === "intents") {
        if (!dryRun) {
          await this.insertRestoreIntents(schema, rows);
          intentRowsImported += rows.length;
        }
      } else if (kind === "audit") {
        if (!dryRun) {
          await this.insertRestoreAudit(schema, rows);
          auditRowsImported += rows.length;
        }
      }
    }

    const durationMs = Date.now() - start;
    this.logger.log(
      `[archival] restore ${date}: done — intents=${intentRowsImported}, ` +
        `audit=${auditRowsImported}, dryRun=${dryRun}, duration=${durationMs}ms`,
    );

    return {
      date,
      schema,
      dryRun,
      intentRowsImported,
      intentRowsRestored: intentRowsImported,
      auditRowsImported,
      rowsImported: intentRowsImported + auditRowsImported,
      filesProcessed: manifest.files.length,
      filesVerified: manifest.files.length,
      durationMs,
      manifestKey,
    };
  }

  /**
   * Create the staging schema and its tables if they do not already exist.
   * Schema name is validated to prevent SQL injection via identifiers.
   */
  private async ensureRestoreSchema(schema: string): Promise<void> {
    const safe = this.assertSafeIdentifier(schema);
    await this.prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${safe}"`);
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${safe}".intents_restore (` +
        `intent_id TEXT PRIMARY KEY, ` +
        `user TEXT NOT NULL, ` +
        `src_chain TEXT NOT NULL, ` +
        `src_token TEXT NOT NULL, ` +
        `src_amount TEXT NOT NULL, ` +
        `dst_token TEXT NOT NULL, ` +
        `min_dst_amount TEXT NOT NULL, ` +
        `quoted_dst_amount TEXT, ` +
        `accepted_dst_amount TEXT, ` +
        `fill_amount TEXT, ` +
        `fee_amount TEXT, ` +
        `solver TEXT, ` +
        `state TEXT NOT NULL, ` +
        `created_at BIGINT NOT NULL, ` +
        `deadline BIGINT NOT NULL, ` +
        `filled_at BIGINT, ` +
        `slashed_at BIGINT, ` +
        `slash_reason TEXT, ` +
        `tx_hash TEXT, ` +
        `version INTEGER NOT NULL, ` +
        `src_verified BOOLEAN NOT NULL, ` +
        `src_token_id TEXT, ` +
        `dst_token_id TEXT, ` +
        `src_decimals INTEGER, ` +
        `dst_decimals INTEGER` +
        `)`,
    );
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${safe}".intent_audit_log_restore (` +
        `id BIGINT PRIMARY KEY, ` +
        `intent_id TEXT NOT NULL, ` +
        `timestamp TEXT NOT NULL, ` +
        `to_state TEXT NOT NULL, ` +
        `actor TEXT NOT NULL, ` +
        `reason TEXT, ` +
        `metadata TEXT` +
        `)`,
    );
  }

  /**
   * Insert intent rows into the staging schema. Idempotent via
   * `ON CONFLICT (intent_id) DO NOTHING`, so concurrent restores are safe.
   */
  private async insertRestoreIntents(
    schema: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    const safe = this.assertSafeIdentifier(schema);
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values: unknown[] = [];
      const placeholders = batch.map((r, idx) => {
        const base = idx * 25;
        values.push(
          r.intent_id,
          r.user,
          r.src_chain,
          r.src_token,
          r.src_amount,
          r.dst_token,
          r.min_dst_amount,
          r.quoted_dst_amount ?? null,
          r.accepted_dst_amount ?? null,
          r.fill_amount ?? null,
          r.fee_amount ?? null,
          r.solver ?? null,
          r.state,
          r.created_at,
          r.deadline,
          r.filled_at ?? null,
          r.slashed_at ?? null,
          r.slash_reason ?? null,
          r.tx_hash ?? null,
          r.version,
          r.src_verified,
          r.src_token_id ?? null,
          r.dst_token_id ?? null,
          r.src_decimals ?? null,
          r.dst_decimals ?? null,
        );
        const cols = Array.from({ length: 25 }, (_, k) => `$${base + k + 1}`);
        return `(${cols.join(", ")})`;
      });
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "${safe}".intents_restore (` +
          `intent_id, user, src_chain, src_token, src_amount, dst_token, ` +
          `min_dst_amount, quoted_dst_amount, accepted_dst_amount, fill_amount, ` +
          `fee_amount, solver, state, created_at, deadline, filled_at, slashed_at, ` +
          `slash_reason, tx_hash, version, src_verified, src_token_id, dst_token_id, ` +
          `src_decimals, dst_decimals` +
          `) VALUES ${placeholders.join(", ")} ` +
          `ON CONFLICT (intent_id) DO NOTHING`,
        ...values,
      );
    }
  }

  /**
   * Insert audit rows into the staging schema. Idempotent via
   * `ON CONFLICT (id) DO NOTHING`.
   */
  private async insertRestoreAudit(
    schema: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    const safe = this.assertSafeIdentifier(schema);
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values: unknown[] = [];
      const placeholders = batch.map((r, idx) => {
        const base = idx * 7;
        values.push(
          r.id,
          r.intent_id,
          r.timestamp,
          r.to_state,
          r.actor,
          r.reason ?? null,
          r.metadata ?? null,
        );
        const cols = Array.from({ length: 7 }, (_, k) => `$${base + k + 1}`);
        return `(${cols.join(", ")})`;
      });
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "${safe}".intent_audit_log_restore (` +
          `id, intent_id, timestamp, to_state, actor, reason, metadata` +
          `) VALUES ${placeholders.join(", ")} ` +
          `ON CONFLICT (id) DO NOTHING`,
        ...values,
      );
    }
  }

  /** Reject schema names that are not simple identifiers. */
  private assertSafeIdentifier(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`[archival] invalid schema identifier: ${name}`);
    }
    return name;
  }

  /**
   * Compute the cutoff date: today minus `retentionDays`.
   * Returns the date string in YYYY-MM-DD format.
   */
  cutoffDate(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - this.archivalConfig.retentionDays);
    return d.toISOString().slice(0, 10);
  }

  // ── Key builders ──────────────────────────────────────────────────────────

  /** Issue #409: which epoch column pair this deployment reads from. */
  private readSource(): "epoch" | "timestamptz" {
    return this.configService.get("timestampReadSource", { infer: true }) ?? "epoch";
  }

  private readsTimestamptz(): boolean {
    return this.readSource() === "timestamptz";
  }

  private manifestKey(date: string): string {
    return `${this.archivalConfig.partitionPrefix}${date}/manifest.json`;
  }

  private intentFileKey(date: string, index: number): string {
    return `${this.archivalConfig.partitionPrefix}${date}/intents-${String(index).padStart(4, "0")}.parquet`;
  }

  private auditFileKey(date: string, index: number): string {
    return `${this.archivalConfig.partitionPrefix}${date}/audit-${String(index).padStart(4, "0")}.parquet`;
  }

  /** Unix epoch bounds [from, to) for a YYYY-MM-DD date string. */
  private dateBounds(date: string): { from: number; to: number } {
    const d = new Date(date + "T00:00:00Z");
    const next = new Date(date + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      from: Math.floor(d.getTime() / 1000),
      to: Math.floor(next.getTime() / 1000),
    };
  }
}
