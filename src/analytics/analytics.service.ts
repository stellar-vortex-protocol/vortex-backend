import { Inject, Injectable, Logger } from "@nestjs/common";
import { Intent, STELLAR_CHAIN } from "../intents/intents.types";
import { IAnalyticsStore, median, medianBigInt } from "./analytics.store";
import { ANALYTICS_STORE } from "./analytics.tokens";
import {
  AnalyticsFillEvent,
  AnalyticsGroupedQuery,
  AnalyticsQuery,
  ChainPairPoint,
  FeesPoint,
  GroupedPoint,
  LatencyPoint,
  SlippagePoint,
  SolverBenchmarkPoint,
  SolverSharePoint,
  TokenPairPoint,
  VolumePoint,
} from "./analytics.types";

/**
 * Query + ingestion entry point for the analytics layer.
 *
 * Ingestion is event-driven: the fill path calls `recordFill()` with the filled
 * intent, and historical data is replayed with `backfill()`. Both build a
 * stable `fill:<intentId>` event id so the store stays idempotent under
 * re-delivery and backfill.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@Inject(ANALYTICS_STORE) private readonly store: IAnalyticsStore) {}

  // ── queries ───────────────────────────────────────────────────────────────

  getVolume(query: AnalyticsQuery): Promise<VolumePoint[]> {
    return this.store.queryVolume(query);
  }

  getFees(query: AnalyticsQuery): Promise<FeesPoint[]> {
    return this.store.queryFees(query);
  }

  getLatency(query: AnalyticsQuery): Promise<LatencyPoint[]> {
    return this.store.queryLatency(query);
  }

  getSolverShare(query: AnalyticsQuery): Promise<SolverSharePoint[]> {
    return this.store.querySolverShare(query);
  }

  getTokenPair(query: AnalyticsQuery): Promise<TokenPairPoint[]> {
    return this.store.queryTokenPair(query);
  }

  getChainPair(query: AnalyticsQuery): Promise<ChainPairPoint[]> {
    return this.store.queryChainPair(query);
  }

  getSlippage(query: AnalyticsQuery): Promise<SlippagePoint[]> {
    return this.store.querySlippage(query);
  }

  /**
   * Compare one solver against the protocol per bucket.
   *
   * The solver's own figures come from the regular latency/volume queries with
   * the `solver` filter applied. The protocol side groups the same buckets by
   * solver (without the solver filter) and takes the median of each active
   * solver's mean latency and volume — "the typical solver", not a fill-weighted
   * average that one large solver would dominate. Every bucket with protocol
   * activity is returned, including ones where the solver had no fills
   * (`solver: null`).
   */
  async getSolverBenchmark(query: AnalyticsQuery, solver: string): Promise<SolverBenchmarkPoint[]> {
    const protocolQuery: AnalyticsQuery = { ...query, solver: undefined };
    const solverQuery: AnalyticsQuery = { ...query, solver };
    const [perSolver, solverLatency, solverVolume] = await Promise.all([
      this.store.queryPerSolver(protocolQuery),
      this.store.queryLatency(solverQuery),
      this.store.queryVolume(solverQuery),
    ]);

    const buckets = new Map<string, { avgMs: number[]; volume: bigint[] }>();
    for (const p of perSolver) {
      const b = buckets.get(p.start) ?? { avgMs: [], volume: [] };
      b.avgMs.push(p.avgMs);
      b.volume.push(BigInt(p.volume));
      buckets.set(p.start, b);
    }
    const latencyByStart = new Map(solverLatency.map((p) => [p.start, p]));
    const volumeByStart = new Map(solverVolume.map((p) => [p.start, p.volume]));

    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([start, b]) => {
        const latency = latencyByStart.get(start);
        return {
          start,
          solver: latency
            ? { avgMs: latency.avgMs, volume: volumeByStart.get(start) ?? "0", count: latency.count }
            : null,
          protocol: {
            medianAvgMs: Math.round(median(b.avgMs)),
            medianVolume: medianBigInt(b.volume).toString(),
            solverCount: b.avgMs.length,
          },
        };
      });
  }

  /** Ad-hoc `volume`/`fees` aggregate grouped by any subset of chain/token/solver. */
  getGrouped(query: AnalyticsGroupedQuery): Promise<GroupedPoint[]> {
    return this.store.queryGrouped(query);
  }

  // ── ingestion ─────────────────────────────────────────────────────────────

  /** Ingest a single filled intent (event-driven). No-op for non-filled intents. */
  async recordFill(intent: Intent): Promise<number> {
    const event = this.toFillEvent(intent);
    if (!event) return 0;
    return this.store.ingest([event]);
  }

  /** Replay historical fills into the analytics store (idempotent). */
  async backfill(intents: Intent[]): Promise<number> {
    const events = intents
      .map((i) => this.toFillEvent(i))
      .filter((e): e is AnalyticsFillEvent => e !== null);
    if (events.length === 0) return 0;
    const inserted = await this.store.ingest(events);
    this.logger.log(`Backfilled ${inserted} fills (${events.length} candidates)`);
    return inserted;
  }

  private toFillEvent(intent: Intent): AnalyticsFillEvent | null {
    if (intent.state !== "filled") return null;
    const filledAt = intent.filledAt ?? intent.createdAt;
    const durationMs = intent.filledAt ? Math.max(0, (intent.filledAt - intent.createdAt) * 1000) : 0;
    return {
      eventId: `fill:${intent.intentId}`,
      timestamp: filledAt * 1000,
      chain: intent.srcChain,
      // Every intent settles on Stellar (`dstToken` is a StellarToken), so the
      // destination chain is fixed until the Intent model grows a dstChain.
      dstChain: STELLAR_CHAIN,
      srcToken: intent.srcToken.symbol,
      dstToken: intent.dstToken.symbol,
      solver: intent.solver ?? "unattributed",
      volume: BigInt(intent.fillAmount ?? "0"),
      fees: BigInt(intent.feeAmount ?? "0"),
      durationMs,
      quotedDstAmount: intent.quotedDstAmount ? BigInt(intent.quotedDstAmount) : null,
    };
  }
}
