import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { LeaderElectionService, Singleton } from "../common/leader-election";
import { MetricsService } from "../metrics/metrics.service";
import { IntentsService } from "../intents/intents.service";
import { IntentState } from "../intents/intents.types";
import { SolversService } from "../solvers/solvers.service";
import { SorobanService } from "./soroban.service";
import { StellarTxService, TtlExtensionOverBudgetError } from "./stellar-tx.service";
import {
  batchKeys,
  bondDataKey,
  contractCodeKey,
  contractInstanceKey,
  dedupeKeys,
  intentDataKey,
  prioritise,
  TrackedLedgerKey,
  TtlContract,
  TtlKeyKind,
  wasmHashFromInstance,
} from "./ttl-keys";

/** Approximate ledger close time used to turn ledgers into wall-clock time. */
export const SECONDS_PER_LEDGER = 5;

/** getLedgerEntries accepts at most 200 keys per request. */
const RPC_MAX_KEYS_PER_READ = 200;

/** Intent states whose on-chain entry must stay live. */
const ACTIVE_INTENT_STATES: readonly IntentState[] = [
  "open",
  "accepted",
  "pending_open",
  "pending_accepted",
  "pending_filled",
  "pending_cancelled",
];

/** TTL status of one tracked entry. */
export type TtlEntryStatus =
  /** Live and above the threshold. */
  | "ok"
  /** Live but at or below the threshold — eligible for extension. */
  | "below_threshold"
  /** Not returned by the RPC: never created, or already archived (needs restore, not extend). */
  | "missing";

/** One row of the admin TTL report. */
export interface TtlReportEntry {
  kind: TtlKeyKind;
  contract: TtlContract;
  subject: string;
  keyXdr: string;
  status: TtlEntryStatus;
  liveUntilLedgerSeq: number | null;
  remainingLedgers: number | null;
  /** remainingLedgers × {@link SECONDS_PER_LEDGER}; an estimate. */
  remainingSecondsApprox: number | null;
}

/** Result of one keeper scan (and, unless report-only, extension pass). */
export interface TtlKeeperReport {
  generatedAt: string;
  latestLedger: number;
  thresholdLedgers: number;
  extendToLedgers: number;
  budget: { day: string; dailyStroops: number; spentStroops: number; remainingStroops: number };
  entries: TtlReportEntry[];
  /** Present when the run attempted extensions. */
  extension?: TtlExtensionSummary;
}

export interface TtlExtensionSummary {
  eligible: number;
  extended: number;
  transactions: Array<{
    keys: number;
    status: "SUCCESS" | "DRY_RUN" | "OVER_BUDGET" | "FAILED";
    hash: string | null;
    feeStroops: number;
    error?: string;
  }>;
  /** True when the run stopped because the daily budget ran out. */
  budgetExhausted: boolean;
}

interface ScannedKey extends TrackedLedgerKey {
  liveUntilLedgerSeq: number | null;
  remainingLedgers: number;
}

/**
 * Contract-state TTL keeper (issue #395).
 *
 * On the elected leader (`ttl-keeper`), every `TTL_KEEPER_INTERVAL_MS`:
 *
 * 1. Derives the protocol-owned persistent keys: each configured contract's
 *    instance and WASM code (read from the instance), every active intent in
 *    the settlement contract, and every active solver's bond in the
 *    solver-registry contract. See `ttl-keys.ts` for the key layout.
 * 2. Reads `liveUntilLedgerSeq` for all of them with `getLedgerEntries`.
 * 3. Extends every live key whose remaining TTL is at or below
 *    `TTL_KEEPER_THRESHOLD_LEDGERS` to `TTL_KEEPER_EXTEND_TO_LEDGERS`, in
 *    `ExtendFootprintTTL` transactions of at most `TTL_KEEPER_MAX_KEYS_PER_TX`
 *    keys — instance and code first, then closest-to-archival.
 * 4. Stops when `TTL_KEEPER_DAILY_BUDGET_STROOPS` (per UTC day) would be
 *    exceeded. The spend counter lives in memory: a leader failover starts the
 *    new leader at zero, so the worst case is twice the budget in one day.
 *
 * Missing entries are reported but never extended — an archived entry needs a
 * restore (handled reactively by `StellarTxService.invokeContract`), and a key
 * that was never created (an intent not yet registered on chain) has nothing
 * to extend. Out of scope: entries the protocol does not own.
 */
@Singleton("ttl-keeper")
@Injectable()
export class TtlKeeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TtlKeeperService.name);
  private interval?: NodeJS.Timeout;
  private running?: Promise<TtlKeeperReport>;
  private budget = { day: "", spentStroops: 0 };
  private lastReport?: TtlKeeperReport;

  constructor(
    private readonly soroban: SorobanService,
    private readonly stellarTx: StellarTxService,
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() private readonly leaderElection?: LeaderElectionService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly intents?: IntentsService,
    @Optional() private readonly solvers?: SolversService,
  ) {}

  onModuleInit(): void {
    if (!this.settings().enabled) {
      this.logger.log("[ttl-keeper] disabled (TTL_KEEPER_ENABLED=false) — report endpoint still available");
      return;
    }
    if (!this.leaderElection) {
      this.logger.warn("[ttl-keeper] no LeaderElectionService — keeper not scheduled");
      return;
    }
    this.leaderElection.registerWorker("ttl-keeper", (isLeader) => {
      if (isLeader) this.start();
      else this.stop();
    });
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Most recent completed report, if any run has finished since boot. */
  getLastReport(): TtlKeeperReport | undefined {
    return this.lastReport;
  }

  /**
   * Scan every tracked key and extend those below the threshold. Concurrent
   * calls share one in-flight run.
   */
  run(): Promise<TtlKeeperReport> {
    this.running ??= this.execute(true).finally(() => (this.running = undefined));
    return this.running;
  }

  /** Scan only — read TTLs and build the report, submit nothing. */
  report(): Promise<TtlKeeperReport> {
    return this.execute(false);
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────

  private start(): void {
    if (this.interval) return;
    const tick = () =>
      void this.run().catch((err: unknown) =>
        this.logger.error(`[ttl-keeper] run failed: ${(err as Error).message}`),
      );
    tick();
    this.interval = setInterval(tick, this.settings().intervalMs);
    this.interval.unref?.();
  }

  private stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  // ── Core ────────────────────────────────────────────────────────────────────

  private async execute(extend: boolean): Promise<TtlKeeperReport> {
    const s = this.settings();
    const keys = await this.deriveKeys();
    const { latestLedger, scanned } = await this.scan(keys);

    const entries = scanned.map((k) => this.toEntry(k, s.thresholdLedgers));
    this.publishGauges(entries);

    let extension: TtlExtensionSummary | undefined;
    if (extend) {
      const eligible = scanned.filter(
        (k) => k.liveUntilLedgerSeq !== null && k.remainingLedgers <= s.thresholdLedgers,
      );
      extension = await this.extend(eligible);
    }

    const budget = this.currentBudget();
    const report: TtlKeeperReport = {
      generatedAt: new Date().toISOString(),
      latestLedger,
      thresholdLedgers: s.thresholdLedgers,
      extendToLedgers: s.extendToLedgers,
      budget: {
        day: budget.day,
        dailyStroops: s.dailyBudgetStroops,
        spentStroops: budget.spentStroops,
        remainingStroops: Math.max(0, s.dailyBudgetStroops - budget.spentStroops),
      },
      entries,
      ...(extension ? { extension } : {}),
    };
    if (extend) {
      this.lastReport = report;
      this.metrics?.markSorobanTtlKeeperRun(Date.now());
    }
    return report;
  }

  /**
   * Build the full tracked-key list. Instance keys come from config; code keys
   * from the instances' WASM hashes; intent and bond keys from DB state.
   */
  async deriveKeys(): Promise<TrackedLedgerKey[]> {
    const s = this.settings();
    const settlementId = this.config.get("stellar.settlementContractId", { infer: true });
    const registryId = this.config.get("stellar.solverRegistryContractId", { infer: true });

    const instances: TrackedLedgerKey[] = [];
    if (settlementId) instances.push(contractInstanceKey("settlement", settlementId));
    if (registryId) instances.push(contractInstanceKey("solver-registry", registryId));
    if (instances.length === 0) return [];

    const codes: TrackedLedgerKey[] = [];
    const { entries } = await this.soroban.getLedgerEntries(...instances.map((k) => k.key));
    for (const entry of entries ?? []) {
      const owner = instances.find((k) => k.keyXdr === entry.key.toXDR("base64"));
      const hash = owner ? wasmHashFromInstance(entry.val) : undefined;
      if (owner && hash) codes.push(contractCodeKey(owner.contract, hash));
    }

    const data: TrackedLedgerKey[] = [];
    if (settlementId && this.intents) {
      for (const state of ACTIVE_INTENT_STATES) {
        for (const intent of await this.intents.getByState(state)) {
          data.push(intentDataKey(settlementId, s.intentKeyVariant, intent.intentId));
        }
      }
    }
    if (registryId && this.solvers) {
      for (const solver of await this.solvers.getAll()) {
        if (!solver.isActive) continue;
        try {
          data.push(bondDataKey(registryId, s.bondKeyVariant, solver.address));
        } catch {
          // A non-Stellar address cannot hold an on-chain bond; skip it.
        }
      }
    }
    return dedupeKeys([...instances, ...codes, ...data]);
  }

  /** Read TTLs for `keys` in RPC-sized chunks. Unreturned keys are missing. */
  private async scan(keys: TrackedLedgerKey[]): Promise<{ latestLedger: number; scanned: ScannedKey[] }> {
    const live = new Map<string, number | null>();
    let latestLedger = 0;
    for (const chunk of batchKeys(keys, RPC_MAX_KEYS_PER_READ)) {
      const response: SorobanRpc.Api.GetLedgerEntriesResponse = await this.soroban.getLedgerEntries(
        ...chunk.map((k) => k.key),
      );
      latestLedger = Math.max(latestLedger, response.latestLedger);
      for (const entry of response.entries ?? []) {
        live.set(entry.key.toXDR("base64"), entry.liveUntilLedgerSeq ?? null);
      }
    }
    if (latestLedger === 0) latestLedger = (await this.soroban.getLatestLedger()).sequence;
    const scanned = keys.map((k) => {
      const liveUntil = live.has(k.keyXdr) ? (live.get(k.keyXdr) ?? null) : null;
      return {
        ...k,
        liveUntilLedgerSeq: liveUntil,
        remainingLedgers: liveUntil === null ? -1 : liveUntil - latestLedger,
      };
    });
    return { latestLedger, scanned };
  }

  /** Extend `eligible` keys within the daily budget. */
  private async extend(eligible: ScannedKey[]): Promise<TtlExtensionSummary> {
    const s = this.settings();
    const summary: TtlExtensionSummary = { eligible: eligible.length, extended: 0, transactions: [], budgetExhausted: false };
    if (eligible.length === 0) return summary;

    for (const batch of batchKeys(prioritise(eligible), s.maxKeysPerTx)) {
      const remaining = s.dailyBudgetStroops - this.currentBudget().spentStroops;
      if (remaining <= 0) {
        summary.budgetExhausted = true;
        break;
      }
      try {
        const result = await this.stellarTx.extendFootprintTtl(
          batch.map((k) => k.key),
          s.extendToLedgers,
          { maxFeeStroops: remaining },
        );
        summary.transactions.push({ keys: batch.length, status: result.status, hash: result.hash, feeStroops: result.feeStroops });
        if (result.status === "OVER_BUDGET") {
          this.metrics?.incSorobanTtlExtensionTx("over_budget");
          summary.budgetExhausted = true;
          break;
        }
        if (result.status === "DRY_RUN") {
          this.metrics?.incSorobanTtlExtensionTx("dry_run");
          continue;
        }
        this.spend(result.feeStroops);
        summary.extended += batch.length;
        this.metrics?.incSorobanTtlExtensionTx("success");
        for (const kind of new Set(batch.map((k) => k.kind))) {
          this.metrics?.incSorobanTtlKeysExtended(kind, batch.filter((k) => k.kind === kind).length);
        }
      } catch (err) {
        const overBudget = err instanceof TtlExtensionOverBudgetError;
        this.metrics?.incSorobanTtlExtensionTx(overBudget ? "over_budget" : "failed");
        summary.transactions.push({
          keys: batch.length,
          status: overBudget ? "OVER_BUDGET" : "FAILED",
          hash: null,
          feeStroops: overBudget ? err.feeStroops : 0,
          error: (err as Error).message,
        });
        this.logger.error(`[ttl-keeper] extension of ${batch.length} keys failed: ${(err as Error).message}`);
        if (overBudget) {
          summary.budgetExhausted = true;
          break;
        }
      }
    }
    if (summary.budgetExhausted) {
      this.logger.warn(
        `[ttl-keeper] daily budget of ${s.dailyBudgetStroops} stroops reached — ` +
          `${summary.eligible - summary.extended} eligible keys left for tomorrow`,
      );
    }
    return summary;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private toEntry(k: ScannedKey, threshold: number): TtlReportEntry {
    const missing = k.liveUntilLedgerSeq === null;
    const remaining = missing ? null : k.remainingLedgers;
    return {
      kind: k.kind,
      contract: k.contract,
      subject: k.subject,
      keyXdr: k.keyXdr,
      status: missing ? "missing" : k.remainingLedgers <= threshold ? "below_threshold" : "ok",
      liveUntilLedgerSeq: k.liveUntilLedgerSeq,
      remainingLedgers: remaining,
      remainingSecondsApprox: remaining === null ? null : Math.max(0, remaining) * SECONDS_PER_LEDGER,
    };
  }

  /** One gauge per (kind, contract): the minimum remaining TTL, -1 if any key is missing. */
  private publishGauges(entries: TtlReportEntry[]): void {
    if (!this.metrics) return;
    const min = new Map<string, number>();
    for (const e of entries) {
      const id = `${e.kind}|${e.contract}`;
      const value = e.remainingLedgers ?? -1;
      const prev = min.get(id);
      min.set(id, prev === undefined ? value : prev === -1 || value === -1 ? -1 : Math.min(prev, value));
    }
    for (const [id, value] of min) {
      const [kind, contract] = id.split("|");
      this.metrics.setSorobanTtlRemaining(kind, contract, value);
    }
  }

  private currentBudget(): { day: string; spentStroops: number } {
    const today = new Date().toISOString().slice(0, 10);
    if (this.budget.day !== today) {
      this.budget = { day: today, spentStroops: 0 };
      this.metrics?.setSorobanTtlBudgetSpent(0);
    }
    return this.budget;
  }

  private spend(stroops: number): void {
    this.currentBudget().spentStroops += stroops;
    this.metrics?.setSorobanTtlBudgetSpent(this.budget.spentStroops);
  }

  private settings(): AppConfig["ttlKeeper"] {
    return this.config.get("ttlKeeper", { infer: true });
  }
}
