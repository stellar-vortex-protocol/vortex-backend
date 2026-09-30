import { Inject, Injectable, Logger } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { Intent } from "../intents/intents.types";
import { SolversService } from "../solvers/solvers.service";
import { SolverRecord } from "../solvers/solvers.types";
import { toCsv } from "./csv-exporter";
import {
  DATASET_KINDS,
  DatasetKind,
  DatasetManifest,
  DatasetRow,
  DatasetsConfig,
} from "./datasets.types";
import { buildManifest, ManifestFileInput } from "./manifest";
import { ObjectStorage } from "./object-storage";
import { toParquet } from "./parquet-exporter";
import { Anonymizer } from "./privacy";
import { DATASET_SCHEMAS, schemaId } from "./schemas";
import { DATASETS_CONFIG, DATASETS_STORAGE } from "./datasets.tokens";

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

@Injectable()
export class DatasetsService {
  private readonly logger = new Logger(DatasetsService.name);
  private readonly anonymizer: Anonymizer;

  constructor(
    @Inject(DATASETS_CONFIG) private readonly config: DatasetsConfig,
    @Inject(DATASETS_STORAGE) private readonly storage: ObjectStorage,
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
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
   * Publish (or re-publish, for reconciliation of late data) a single UTC day.
   * Returns the manifest written to object storage.
   */
  async exportDaily(targetDate: Date = new Date()): Promise<DatasetManifest> {
    const { dateKey, startSec, endSec } = this.dayBounds(targetDate);

    const [intents, solvers] = await Promise.all([
      this.intentsService.getAll(),
      this.solversService.getAll(),
    ]);

    const dayIntents = intents.filter((i) => i.createdAt >= startSec && i.createdAt < endSec);

    const rows: Record<DatasetKind, DatasetRow[]> = {
      intents: dayIntents.map((i) => this.toIntentRow(i)),
      fills: dayIntents.filter((i) => i.state === "filled").map((i) => this.toFillRow(i)),
      solver_stats: solvers.map((s) => this.toSolverRow(s)),
      fees: dayIntents
        .filter((i) => i.state === "filled" && typeof i.feeAmount === "string" && i.feeAmount.length > 0)
        .map((i) => this.toFeeRow(i)),
    };

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

    await this.storage.put(
      this.keyFor(dateKey, revision, "manifest.json"),
      Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    );

    this.logger.log(
      `Published ${dateKey} rev ${revision} (${rowCounts.intents} intents, ${rowCounts.fills} fills)`,
    );
    return manifest;
  }

  // ── internal helpers ──────────────────────────────────────────────────────

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
