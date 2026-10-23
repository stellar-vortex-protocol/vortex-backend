import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { Intent } from "../intents/intents.types";
import { SolversService } from "../solvers/solvers.service";
import { SolverRecord } from "../solvers/solvers.types";
import { toCsv } from "./csv-exporter";
import {
  DATASET_KINDS,
  DatasetKind,
  DatasetManifest,
  DatasetRangeExport,
  DatasetRangeExportRequest,
  DatasetRow,
  DatasetsConfig,
} from "./datasets.types";
import { buildManifest, checksum, ManifestFileInput } from "./manifest";
import { ObjectStorage } from "./object-storage";
import { toParquet } from "./parquet-exporter";
import { Anonymizer } from "./privacy";
import { DATASET_SCHEMAS, schemaId } from "./schemas";
import { DATASETS_CONFIG, DATASETS_STORAGE } from "./datasets.tokens";
import { DatasetWebhookNotifier } from "./dataset-webhook.notifier";

/** Summary of one published dataset kind, for the listing endpoint. */
export interface DatasetListingEntry {
  kind: DatasetKind;
  schema: string;
  schemaVersion: string;
  rowCount: number;
  formats: string[];
}

/** Summary of one publication (date + revision) for the listing endpoint. */
export interface DatasetPublication {
  date: string;
  revision: number;
  generatedAt: string;
  watermark: string | null;
  datasets: DatasetListingEntry[];
}

const DAY_MS = 86_400_000;
const DEFAULT_EXPORT_MAX_DAYS = 31;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Half-open range of intent creation times, Unix epoch seconds. */
interface SecondsRange {
  startSec: number;
  endSec: number;
}

/** Source records the row builders read from. */
interface DatasetSources {
  intents: Intent[];
  solvers: SolverRecord[];
}

const CONTENT_TYPES = { csv: "text/csv; charset=utf-8", parquet: "application/vnd.apache.parquet" } as const;

@Injectable()
export class DatasetsService {
  private readonly logger = new Logger(DatasetsService.name);
  private readonly anonymizer: Anonymizer;

  constructor(
    @Inject(DATASETS_CONFIG) private readonly config: DatasetsConfig,
    @Inject(DATASETS_STORAGE) private readonly storage: ObjectStorage,
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    @Optional() private readonly webhookNotifier?: DatasetWebhookNotifier,
  ) {
    this.anonymizer = new Anonymizer(
      config.salt,
      config.saltRotationHours,
      config.saltRetentionWindows,
    );
  }

  /** List every available schema (name + version + fields). */
  listSchemas() {
    return DATASET_KINDS.map((kind) => {
      const schema = DATASET_SCHEMAS[kind];
      return {
        kind,
        schema: schemaId(schema),
        schemaVersion: `${schema.version.major}.${schema.version.minor}`,
        fields: schema.fields.map((f) => ({ name: f.name, type: f.type, optional: !!f.optional })),
      };
    });
  }

  /** List every published dataset date, revision, and schema. */
  async listDatasets(): Promise<DatasetPublication[]> {
    const prefix = `${this.config.publicBucket}/datasets/`;
    const keys = await this.storage.list(prefix);
    const manifestKeys = keys.filter((k) => /manifest\.json$/.test(k));

    const publications: DatasetPublication[] = [];
    for (const key of manifestKeys) {
      const body = await this.storage.get(key);
      if (!body) continue;
      let manifest: DatasetManifest;
      try {
        manifest = JSON.parse(body.toString("utf8")) as DatasetManifest;
      } catch {
        this.logger.warn(`Skipping unparseable manifest at ${key}`);
        continue;
      }
      publications.push(this.toPublication(manifest));
    }

    return publications.sort((a, b) =>
      a.date === b.date ? b.revision - a.revision : b.date.localeCompare(a.date),
    );
  }

  /**
   * The most recent publication (newest date, then highest revision), or
   * `null` when nothing has been published yet.
   *
   * This reuses `listDatasets()`'s ordering for correctness. If the full
   * manifest scan ever gets too slow, the natural optimisation is to write a
   * small "latest" pointer object alongside each manifest and read only that.
   */
  async getLatest(): Promise<DatasetPublication | null> {
    return (await this.listDatasets())[0] ?? null;
  }

  /**
   * Publish (or re-publish, for reconciliation of late data) a single UTC day.
   * Returns the manifest written to object storage.
   */
  async exportDaily(targetDate: Date = new Date()): Promise<DatasetManifest> {
    const { dateKey, startSec, endSec } = this.dayBounds(targetDate);

    const range = { startSec, endSec };
    const sources = await this.loadSources();
    const dayIntents = this.intentsInRange(sources.intents, range);

    const rows = Object.fromEntries(
      DATASET_KINDS.map((kind) => [kind, this.rowsForRange(kind, range, sources)]),
    ) as Record<DatasetKind, DatasetRow[]>;

    const rowCounts = Object.fromEntries(
      DATASET_KINDS.map((k) => [k, rows[k].length]),
    ) as Record<DatasetKind, number>;

    const watermark = this.computeWatermark(dayIntents);
    const revision = await this.nextRevision(dateKey);
    const generatedAt = new Date();

    // Serialise every dataset to CSV + Parquet.
    const files: ManifestFileInput[] = [];
    for (const kind of DATASET_KINDS) {
      const schema = DATASET_SCHEMAS[kind];
      const csvBytes = toCsv(schema, rows[kind]);
      const parquetBytes = await toParquet(schema, rows[kind], {
        schema: schemaId(schema),
        date: dateKey,
      });

      files.push({ format: "csv", kind, bytes: csvBytes });
      if (parquetBytes) files.push({ format: "parquet", kind, bytes: parquetBytes });

      await this.storage.put(this.keyFor(dateKey, revision, `${kind}.csv`), csvBytes);
      if (parquetBytes) {
        await this.storage.put(this.keyFor(dateKey, revision, `${kind}.parquet`), parquetBytes);
      }
    }

    const manifest = buildManifest({
      schema: DATASET_SCHEMAS.intents,
      date: dateKey,
      revision,
      generatedAt,
      watermark,
      rowCounts,
      files,
    });

    const manifestBody = JSON.stringify(manifest, null, 2);
    await this.storage.put(
      this.keyFor(dateKey, revision, "manifest.json"),
      Buffer.from(manifestBody, "utf8"),
    );

    this.logger.log(
      `Published ${dateKey} rev ${revision} (${rowCounts.intents} intents, ${rowCounts.fills} fills)`,
    );

    // Best-effort notification. The manifest is already persisted and the
    // notifier never throws, so a failing subscriber cannot fail the export.
    if (this.webhookNotifier) {
      await this.webhookNotifier.notify(manifest, manifestBody);
    }
    return manifest;
  }

  /**
   * On-demand export of one dataset kind over a range of whole UTC days
   * (issue #592). Uses the same row builders, anonymiser and serialisers as
   * {@link exportDaily}; the result is returned, not published.
   */
  async exportRange(request: DatasetRangeExportRequest): Promise<DatasetRangeExport> {
    const { kind, from, to, format } = request;
    const range = this.rangeFromDays(from, to);

    const sources = await this.loadSources();
    const rows = this.rowsForRange(kind, range, sources);
    const schema = DATASET_SCHEMAS[kind];

    const body =
      format === "csv"
        ? toCsv(schema, rows)
        : await toParquet(schema, rows, { schema: schemaId(schema), from, to });
    if (!body) {
      // toParquet() cannot write a file with no rows.
      throw new NotFoundException(
        `No ${kind} rows between ${from} and ${to}; an empty range can only be exported as csv`,
      );
    }

    const watermark = this.computeWatermark(this.intentsInRange(sources.intents, range));
    const fileName = `${kind}_${from}_${to}.${format}`;
    return {
      body,
      contentType: CONTENT_TYPES[format],
      manifest: {
        schema: schemaId(schema),
        schemaVersion: `${schema.version.major}.${schema.version.minor}`,
        kind,
        format,
        from,
        to,
        generatedAt: new Date().toISOString(),
        watermark: watermark ? watermark.toISOString() : null,
        rowCount: rows.length,
        sizeBytes: body.length,
        sha256: checksum(body),
        fileName,
      },
    };
  }

  /** Rows for one dataset kind whose intents were created in [startSec, endSec). */
  async buildRowsForRange(kind: DatasetKind, startSec: number, endSec: number): Promise<DatasetRow[]> {
    return this.rowsForRange(kind, { startSec, endSec }, await this.loadSources());
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private async loadSources(): Promise<DatasetSources> {
    const [intents, solvers] = await Promise.all([
      this.intentsService.getAll(),
      this.solversService.getAll(),
    ]);
    return { intents, solvers };
  }

  private intentsInRange(intents: Intent[], { startSec, endSec }: SecondsRange): Intent[] {
    return intents.filter((i) => i.createdAt >= startSec && i.createdAt < endSec);
  }

  /**
   * The single row-building path for every export. Each row is anonymised with
   * the salt window active at that row's own timestamp, so a range crossing a
   * salt rotation hashes each side with its own salt. `solver_stats` is a
   * point-in-time snapshot and ignores the range.
   */
  private rowsForRange(kind: DatasetKind, range: SecondsRange, sources: DatasetSources): DatasetRow[] {
    if (kind === "solver_stats") return sources.solvers.map((s) => this.toSolverRow(s));

    const intents = this.intentsInRange(sources.intents, range);
    switch (kind) {
      case "intents":
        return intents.map((i) => this.toIntentRow(i));
      case "fills":
        return intents.filter((i) => i.state === "filled").map((i) => this.toFillRow(i));
      case "fees":
        return intents
          .filter((i) => i.state === "filled" && typeof i.feeAmount === "string" && i.feeAmount.length > 0)
          .map((i) => this.toFeeRow(i));
    }
  }

  /** Validate inclusive YYYY-MM-DD bounds and turn them into a seconds range. */
  private rangeFromDays(from: string, to: string): SecondsRange {
    const start = this.parseDay(from, "from");
    const last = this.parseDay(to, "to");
    if (last < start) throw new BadRequestException("`to` must be on or after `from`");

    const days = (last - start) / DAY_MS + 1;
    const maxDays = this.config.exportMaxDays ?? DEFAULT_EXPORT_MAX_DAYS;
    if (days > maxDays) {
      throw new BadRequestException(`Range covers ${days} days; the maximum is ${maxDays}`);
    }
    return { startSec: start / 1000, endSec: (last + DAY_MS) / 1000 };
  }

  private parseDay(value: string, field: string): number {
    const ms = DATE_RE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    // The round-trip rejects dates JS would roll over, like 2026-02-30.
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(`\`${field}\` must be a valid UTC date in YYYY-MM-DD form`);
    }
    return ms;
  }

  private dayBounds(date: Date): { dateKey: string; startSec: number; endSec: number } {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const end = start + DAY_MS;
    const dateKey = new Date(start).toISOString().slice(0, 10);
    return { dateKey, startSec: start / 1000, endSec: end / 1000 };
  }

  private keyFor(date: string, revision: number, fileName: string): string {
    return `${this.config.publicBucket}/datasets/${date}/rev-${revision}/${fileName}`;
  }

  private async nextRevision(date: string): Promise<number> {
    const prefix = `${this.config.publicBucket}/datasets/${date}/`;
    const keys = await this.storage.list(prefix);
    let max = 0;
    for (const key of keys) {
      const match = key.match(/rev-(\d+)\//);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return max + 1;
  }

  private computeWatermark(intents: Intent[]): Date | null {
    let maxSec = 0;
    for (const intent of intents) {
      const t = intent.filledAt ?? intent.createdAt;
      if (t > maxSec) maxSec = t;
    }
    return maxSec === 0 ? null : new Date(maxSec * 1000);
  }

  private anonymize(user: string, createdAtSec: number): string {
    if (!this.config.anonymize) return user;
    return this.anonymizer.hash(user, createdAtSec * 1000);
  }

  private toIntentRow(intent: Intent): DatasetRow {
    return {
      intentId: intent.intentId,
      user: this.anonymize(intent.user, intent.createdAt),
      srcChain: intent.srcChain,
      srcToken: intent.srcToken.address,
      srcTokenSymbol: intent.srcToken.symbol,
      dstToken: intent.dstToken.contract,
      dstTokenSymbol: intent.dstToken.symbol,
      srcAmount: intent.srcAmount,
      minDstAmount: intent.minDstAmount,
      quotedDstAmount: intent.quotedDstAmount ?? null,
      solver: intent.solver ?? null,
      state: intent.state,
      createdAt: intent.createdAt,
      deadline: intent.deadline,
      filledAt: intent.filledAt ?? null,
      fillAmount: intent.fillAmount ?? null,
      feeAmount: intent.feeAmount ?? null,
      txHash: intent.txHash ?? null,
    };
  }

  private toFillRow(intent: Intent): DatasetRow {
    return {
      intentId: intent.intentId,
      solver: intent.solver ?? null,
      srcChain: intent.srcChain,
      dstToken: intent.dstToken.contract,
      fillAmount: intent.fillAmount ?? "0",
      feeAmount: intent.feeAmount ?? null,
      createdAt: intent.createdAt,
      filledAt: intent.filledAt ?? null,
      txHash: intent.txHash ?? null,
    };
  }

  private toSolverRow(solver: SolverRecord): DatasetRow {
    return {
      address: solver.address,
      name: solver.name,
      bondAmount: solver.bondAmount,
      fillsCompleted: solver.fillsCompleted,
      fillsFailed: solver.fillsFailed,
      totalVolume: solver.totalVolume,
      avgFillTime: solver.avgFillTime,
      isActive: solver.isActive,
      registeredAt: solver.registeredAt,
      lastActiveAt: solver.lastActiveAt,
      supportedChains: solver.supportedChains.join(","),
      supportedTokens: solver.supportedTokens.join(","),
    };
  }

  private toFeeRow(intent: Intent): DatasetRow {
    return {
      intentId: intent.intentId,
      solver: intent.solver ?? null,
      srcChain: intent.srcChain,
      dstToken: intent.dstToken.contract,
      feeAmount: intent.feeAmount ?? "0",
      filledAt: intent.filledAt ?? null,
    };
  }

  private toPublication(manifest: DatasetManifest): DatasetPublication {
    const byKind = new Map<DatasetKind, DatasetListingEntry>();
    for (const file of manifest.files) {
      const kind = file.name.split(".")[0] as DatasetKind;
      const existing = byKind.get(kind);
      if (existing) {
        existing.formats.push(file.format);
      } else {
        byKind.set(kind, {
          kind,
          schema: manifest.schema,
          schemaVersion: manifest.schemaVersion,
          rowCount: file.rowCount,
          formats: [file.format],
        });
      }
    }

    return {
      date: manifest.date,
      revision: manifest.revision,
      generatedAt: manifest.generatedAt,
      watermark: manifest.watermark,
      datasets: [...byKind.values()],
    };
  }
}
