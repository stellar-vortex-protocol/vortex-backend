import { Inject, Injectable, Logger } from "@nestjs/common";
import { Intent } from "../intents/intents.types";
import { IAnalyticsStore } from "./analytics.store";
import { ANALYTICS_STORE } from "./analytics.tokens";
import {
  AnalyticsFillEvent,
  AnalyticsQuery,
  FeesPoint,
  LatencyPoint,
  SolverSharePoint,
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
      srcToken: intent.srcToken.symbol,
      dstToken: intent.dstToken.symbol,
      solver: intent.solver ?? "unattributed",
      volume: BigInt(intent.fillAmount ?? "0"),
      fees: BigInt(intent.feeAmount ?? "0"),
      durationMs,
    };
  }
}
