import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import client from "prom-client";
import { AppConfig } from "../config/configuration";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestTotal: client.Counter<string>;
  public readonly httpRequestErrors: client.Counter<string>;
  public readonly intentStateTransitions: client.Counter<string>;
  public readonly wsConnections: client.Gauge<string>;

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;

  // ── TxConfirmationService metrics (#386) ──────────────────────────────────
  public readonly txConfirmationLatency: client.Histogram<string>;
  public readonly txConfirmationOutcomes: client.Counter<string>;

  // ── FeeEscalationPolicy metrics (#388) ────────────────────────────────────
  public readonly txFeeBumpTotal: client.Counter<string>;
  public readonly txFeeBumpCeilingHits: client.Counter<string>;

  // ── ChannelPoolService metrics (#387) ─────────────────────────────────────
  public readonly channelPoolUtilisation: client.Gauge<string>;
  public readonly channelLeaseWaitTime: client.Histogram<string>;
  public readonly channelBadSeqResyncs: client.Counter<string>;

  // ── EventIngestionService metrics (#389) ──────────────────────────────────
  public readonly ingestionDeadLetterTotal: client.Counter<string>;
  public readonly ingestionCursorLag: client.Gauge<string>;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.register = new client.Registry();
    const prefix = "vortex_";

    this.httpRequestDuration = new client.Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.httpRequestTotal = new client.Counter({
      name: `${prefix}http_requests_total`,
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.httpRequestErrors = new client.Counter({
      name: `${prefix}http_request_errors_total`,
      help: "Total number of HTTP request errors (5xx)",
      labelNames: ["method", "route", "status_code"],
      registers: [this.register],
    });

    this.intentStateTransitions = new client.Counter({
      name: `${prefix}intent_state_transitions_total`,
      help: "Total number of intent state transitions",
      labelNames: ["from_state", "to_state"],
      registers: [this.register],
    });

    this.wsConnections = new client.Gauge({
      name: `${prefix}ws_connections_active`,
      help: "Number of active WebSocket connections",
      registers: [this.register],
    });

    // ── Sweeper metrics (issue #259) ─────────────────────────────────────────
    // These replace the retired MetricsRegistry.sweeper namespace from
    // src/common/metrics.ts. They are Prometheus-backed so they appear in
    // GET /metrics and in any Prometheus/Grafana dashboards without further
    // adaptation.

    this.sweeperExpiredTotal = new client.Counter({
      name: `${prefix}sweeper_expired_total`,
      help: "Total number of intents expired across all sweeps",
      registers: [this.register],
    });

    this.sweeperSweepDurationMs = new client.Histogram({
      name: `${prefix}sweeper_sweep_duration_ms`,
      help: "Duration of each IntentsSweeperService.sweep() execution in milliseconds",
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.register],
    });

    // ── TxConfirmationService metrics (#386) ──────────────────────────────────
    this.txConfirmationLatency = new client.Histogram({
      name: `${prefix}tx_confirmation_latency_seconds`,
      help: "Time from tx submission to final confirmation/failure/expiry",
      buckets: [1, 5, 10, 30, 60, 120, 300, 600],
      registers: [this.register],
    });

    this.txConfirmationOutcomes = new client.Counter({
      name: `${prefix}tx_confirmation_outcomes_total`,
      help: "Count of transaction confirmation outcomes by status",
      labelNames: ["status"],
      registers: [this.register],
    });

    // ── FeeEscalationPolicy metrics (#388) ────────────────────────────────────
    this.txFeeBumpTotal = new client.Counter({
      name: `${prefix}tx_fee_bump_total`,
      help: "Total fee-bump escalations applied, by percentile tier",
      labelNames: ["percentile"],
      registers: [this.register],
    });

    this.txFeeBumpCeilingHits = new client.Counter({
      name: `${prefix}tx_fee_bump_ceiling_hits_total`,
      help: "Times fee-bump was refused because the ceiling would be exceeded",
      registers: [this.register],
    });

    // ── ChannelPoolService metrics (#387) ─────────────────────────────────────
    this.channelPoolUtilisation = new client.Gauge({
      name: `${prefix}channel_pool_utilisation`,
      help: "Fraction of channel accounts currently leased (0–1)",
      registers: [this.register],
    });

    this.channelLeaseWaitTime = new client.Histogram({
      name: `${prefix}channel_lease_wait_seconds`,
      help: "Time waiting for a free channel account",
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.channelBadSeqResyncs = new client.Counter({
      name: `${prefix}channel_bad_seq_resyncs_total`,
      help: "Number of sequence number re-syncs triggered by tx_bad_seq or lease timeout",
      registers: [this.register],
    });

    // ── EventIngestionService metrics (#389) ──────────────────────────────────
    this.ingestionDeadLetterTotal = new client.Counter({
      name: `${prefix}ingestion_dead_letter_total`,
      help: "Events moved to dead-letter table after repeated failures",
      registers: [this.register],
    });

    this.ingestionCursorLag = new client.Gauge({
      name: `${prefix}ingestion_cursor_lag_ledgers`,
      help: "Gap between latest on-chain ledger and last processed ledger",
      registers: [this.register],
    });
  }

  onModuleInit() {
    const prefix = "vortex_";
    client.collectDefaultMetrics({ register: this.register, prefix });
  }

  async metrics(): Promise<string> {
    return this.register.metrics();
  }

  contentType(): string {
    return this.register.contentType;
  }

  incIntentStateTransition(from: string, to: string) {
    this.intentStateTransitions.inc({ from_state: from, to_state: to });
  }

  incWsConnection() {
    this.wsConnections.inc();
  }

  decWsConnection() {
    this.wsConnections.dec();
  }

  /**
   * Record one sweeper cycle's expired count and duration.
   * Called by IntentsSweeperService at the end of every sweep() invocation.
   */
  recordSweep(expiredCount: number, durationMs: number): void {
    this.sweeperExpiredTotal.inc(expiredCount);
    this.sweeperSweepDurationMs.observe(durationMs);
  }
}
