import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { IIntentsRepository, INTENTS_REPOSITORY } from "./intents.repository";
import { Intent } from "./intents.types";

/** Maximum number of mismatch samples included in a report / log line. */
const MAX_SAMPLES = 5;

export type StoreMismatchKind = "missing_in_postgres" | "missing_in_memory" | "field_mismatch";

export interface StoreMismatchSample {
  intentId: string;
  kind: StoreMismatchKind;
  /** Fields whose values differ (field_mismatch only). */
  fields?: string[];
}

/** Result of one consistency-verifier pass. */
export interface StoreVerificationReport {
  checkedAt: string;
  memoryCount: number;
  postgresCount: number;
  mismatches: Record<StoreMismatchKind, number>;
  samples: StoreMismatchSample[];
}

/**
 * Consistency verifier for `INTENTS_STORE=dual` (issue #404).
 *
 * On boot it backfills the in-memory store from Postgres (and pushes any
 * memory-only rows the other way). Every INTENTS_VERIFY_INTERVAL_MS it then
 * compares both stores record-by-record and publishes the mismatch count per
 * kind to Prometheus (`vortex_intents_store_mismatches{kind}`), logging up to
 * five samples. A clean run of zero mismatches over a soak period is the
 * signal that it is safe to switch reads to `INTENTS_STORE=postgres` — see
 * docs/runbooks/intents-store-migration.md.
 *
 * Inert in `memory` and `postgres` modes.
 */
@Injectable()
export class IntentsStoreVerifierService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentsStoreVerifierService.name);
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(INTENTS_REPOSITORY) private readonly repo: IIntentsRepository,
    private readonly configService: ConfigService<AppConfig, true>,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** True when the active repository is the dual-write adapter. */
  get enabled(): boolean {
    return this.repo instanceof DualWriteIntentsRepository;
  }

  async onModuleInit(): Promise<void> {
    if (!(this.repo instanceof DualWriteIntentsRepository)) return;

    const { loadedFromPostgres, pushedToPostgres } = await this.repo.backfill();
    this.logger.log(
      `[intents-store] dual-write backfill complete: loadedFromPostgres=${loadedFromPostgres} pushedToPostgres=${pushedToPostgres}`,
    );

    const intervalMs = Number(this.configService.get("intentsVerifyIntervalMs", { infer: true })) || 60_000;
    this.interval = setInterval(() => {
      this.verify().catch((err) =>
        this.logger.error(`[intents-store] consistency verification failed: ${(err as Error).message}`),
      );
    }, intervalMs);
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /**
   * Compare the memory and Postgres stores once. Returns `null` when the
   * active store is not `dual` or a previous run is still in progress.
   */
  async verify(): Promise<StoreVerificationReport | null> {
    if (!(this.repo instanceof DualWriteIntentsRepository) || this.running) return null;
    this.running = true;
    try {
      const [memory, postgres] = await Promise.all([
        this.repo.primary.findAll(),
        this.repo.secondary.findAll(),
      ]);
      const report = compareStores(memory, postgres);

      this.metrics?.recordStoreVerification(report.mismatches);
      const total = Object.values(report.mismatches).reduce((a, b) => a + b, 0);
      if (total > 0) {
        this.logger.warn(
          `[intents-store] ${total} mismatch(es) between memory and Postgres ` +
            `${JSON.stringify(report.mismatches)} samples=${JSON.stringify(report.samples)}`,
        );
      } else {
        this.logger.debug(`[intents-store] stores consistent (${report.memoryCount} intents)`);
      }
      return report;
    } finally {
      this.running = false;
    }
  }
}

/** Pure comparison of two intent snapshots, exported for unit tests. */
export function compareStores(memory: Intent[], postgres: Intent[]): StoreVerificationReport {
  const mismatches: Record<StoreMismatchKind, number> = {
    missing_in_postgres: 0,
    missing_in_memory: 0,
    field_mismatch: 0,
  };
  const samples: StoreMismatchSample[] = [];
  const sample = (s: StoreMismatchSample) => {
    mismatches[s.kind]++;
    if (samples.length < MAX_SAMPLES) samples.push(s);
  };

  const dbById = new Map(postgres.map((i) => [i.intentId, i]));
  const memoryIds = new Set<string>();

  for (const local of memory) {
    memoryIds.add(local.intentId);
    const remote = dbById.get(local.intentId);
    if (!remote) {
      sample({ intentId: local.intentId, kind: "missing_in_postgres" });
      continue;
    }
    const fields = diffFields(local, remote);
    if (fields.length > 0) sample({ intentId: local.intentId, kind: "field_mismatch", fields });
  }

  for (const remote of postgres) {
    if (!memoryIds.has(remote.intentId)) sample({ intentId: remote.intentId, kind: "missing_in_memory" });
  }

  return {
    checkedAt: new Date().toISOString(),
    memoryCount: memory.length,
    postgresCount: postgres.length,
    mismatches,
    samples,
  };
}

function diffFields(a: Intent, b: Intent): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Intent>;
  return [...keys].filter((k) => stableStringify(a[k]) !== stableStringify(b[k])).sort();
}

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => x.localeCompare(y));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
