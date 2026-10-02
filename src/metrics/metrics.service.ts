import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import client from "prom-client";
import { AppConfig } from "../config/configuration";

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;

  // ── HTTP ───────────────────────────────────────────────────────────────────
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestTotal: client.Counter<string>;
  public readonly httpRequestErrors: client.Counter<string>;

  // ── Intent / WS general ───────────────────────────────────────────────────
  public readonly intentStateTransitions: client.Counter<string>;
  public readonly wsConnections: client.Gauge<string>;
  public readonly intentCreateDuration: client.Histogram<string>;
  public readonly wsDeliveryDuration: client.Histogram<string>;
  public readonly eventIngestionLag: client.Gauge<string>;

  /**
   * Shadow-mode divergence monitor (issue #401).
   *
   * `vortex_shadow_comparisons_total{transition,outcome}` counts every
   * (expected, simulated) pair the monitor resolved, and
   * `vortex_shadow_divergences_total{transition,reason}` counts the subset the
   * classifier flagged. `vortex_shadow_dropped_total` and
   * `vortex_shadow_queue_depth` expose monitor health so a starved monitor is
   * never mistaken for a healthy one — the on-chain cutover runbook's go/no-go
   * threshold is only meaningful while these are being exercised.
   */
  public readonly shadowComparisons: client.Counter<string>;
  public readonly shadowDivergences: client.Counter<string>;
  public readonly shadowDropped: client.Counter<string>;
  public readonly shadowQueueDepth: client.Gauge<string>;

  /**
   * Leader election metrics (issue #493).
   * Track which replica is leader per worker and how often leadership changes.
   */
  public readonly leaderElectionIsLeader: client.Gauge<string>;
  public readonly leaderElectionChangesTotal: client.Counter<string>;

  /** Background job metrics (issue #494). */
  public readonly jobsQueueDepth: client.Gauge<string>;
  public readonly jobsDuration: client.Histogram<string>;
  public readonly jobsFailures: client.Counter<string>;
  public readonly jobsDeadLettered: client.Counter<string>;
  private queueDepthProvider?: () => Promise<Array<{ queue: string; state: string; count: number }>>;

  /** Feature-flag evaluations (issue #495). */
  public readonly flagEvaluations: client.Counter<string>;
  // ── WS backplane (issue #454) ─────────────────────────────────────────────
  public readonly wsBackplanePublishDuration: client.Histogram<string>;
  public readonly wsBackplaneDropped: client.Counter<string>;
  public readonly wsBackplaneConnected: client.Gauge<string>;

  // ── WS hardening (issue #455) ─────────────────────────────────────────────
  public readonly wsConnectionsRejected: client.Counter<string>;
  public readonly wsRateLimited: client.Counter<string>;
  public readonly wsOutboundDropped: client.Counter<string>;
  public readonly wsSlowConsumerDisconnects: client.Counter<string>;

  // ── Health (issue #492) ───────────────────────────────────────────────────
  public readonly healthIndicatorUp: client.Gauge<string>;
  public readonly healthReady: client.Gauge<string>;
  public readonly healthCheckDuration: client.Histogram<string>;

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;
  /** Intents the low-frequency safety sweep expired or slashed. Steady state is ~0. */
  public readonly sweeperSafetyCaughtTotal: client.Counter<string>;

  // ── SLO SLIs (issue #480) ─────────────────────────────────────────────────
  public readonly txConfirmationDuration: client.Histogram<string>;

  // ── WS capability-filter metrics (issue #436) ────────────────────────────
  /**
   * WS events delivered to an authenticated solver after capability filtering.
   * Label `solver` is truncated to 12 chars to bound Prometheus label cardinality.
   */
  public readonly wsEventsDeliveredTotal: client.Counter<string>;
  /**
   * WS events suppressed by the capability filter (intent outside solver's
   * supported chains/tokens or solver bond = 0).
   */
  public readonly wsEventsFilteredTotal: client.Counter<string>;

  // ── Restore-transaction metrics (issue #394) ─────────────────────────────
  public readonly sorobanRestoreTotal: client.Counter<string>;
  public readonly sorobanRestoreFeeStroops: client.Histogram<string>;

  // ── Remote signer call latency (issue #400) ───────────────────────────────
  public readonly signerCallDurationSeconds: client.Histogram<string>;

  // ── Solver-registry event ingestion (issue #399) ──────────────────────────
  public readonly solverRegistryEventsTotal: client.Counter<string>;

  // ── Anti-griefing controls (issue #453) ──────────────────────────────────
  /**
   * `vortex_griefing_state_transitions_total{solver,from_state,to_state}` — counts
   * every enforcement escalation/recovery for a solver.  Solver label is
   * truncated to 12 chars to bound cardinality.
   */
  public readonly griefingStateTransitionsTotal: client.Counter<string>;
  /**
   * `vortex_griefing_unfilled_ratio{solver}` — current rolling unfilled/accept
   * ratio per solver under enforcement (Gauge, updated on each unfilled event).
   */
  public readonly griefingUnfilledRatio: client.Gauge<string>;
  /**
   * `vortex_griefing_enforced_solvers` — number of solvers currently NOT in
   * the "ok" state.
   */
  public readonly griefingEnforcedSolvers: client.Gauge<string>;
  /**
   * `vortex_griefing_enforcement_state{solver,state}` — current enforcement
   * state as a 0/1 gauge per (solver, state) label pair.  Allows dashboards and
   * alerts to query "how many solvers are suspended right now" with a simple
   * `sum(vortex_griefing_enforcement_state{state="suspended"})`.
   */
  public readonly griefingEnforcementState: client.Gauge<string>;
  /**
   * `vortex_griefing_concurrency_limit{solver}` — effective concurrent-accept
   * cap while in "reduced-concurrency" state; 0 when no limit is active.
   */
  public readonly griefingConcurrencyLimit: client.Gauge<string>;
  public readonly legacyStellarSignatures: client.Counter<string>;

  /** Dual-write / consistency-verifier metrics (issue #404). */
  public readonly intentsDualWriteFailuresTotal: client.Counter<string>;
  public readonly intentsStoreMismatches: client.Gauge<string>;
  public readonly intentsStoreMismatchesTotal: client.Counter<string>;
  public readonly intentsStoreVerifierRunsTotal: client.Counter<string>;

  /** Contract version gating metrics (issue #402). */
  public readonly contractVersionSupported: client.Gauge<string>;
  public readonly contractUpgradesTotal: client.Counter<string>;
  public readonly contractWritesBlockedTotal: client.Counter<string>;

  /** Source-chain deposit verification (issue #403). */
  public readonly srcVerificationsTotal: client.Counter<string>;
  public readonly srcVerificationErrorsTotal: client.Counter<string>;
  public readonly srcVerificationQueueSize: client.Gauge<string>;

  /** Transactional outbox relay (issue #396). */
  public readonly outboxRelayOutcomes: client.Counter<string>;
  public readonly outboxDeadTotal: client.Counter<string>;
  public readonly outboxBacklog: client.Gauge<string>;

  /** Slashing saga (issue #397). */
  public readonly slashTransitions: client.Counter<string>;

  // ── Channel pool leasing (issue #473) ─────────────────────────────────────
  /** Seconds spent waiting for a channel lease before the attempt resolved. */
  public readonly channelLeaseWaitTime: client.Histogram<string>;
  /** `Seq`-mismatch reconnects forced on a channel by a bad sequence number. */
  public readonly channelBadSeqResyncs: client.Counter<string>;
  /** Fraction (0..1) of the channel pool currently leased. */
  public readonly channelPoolUtilisation: client.Gauge<string>;

  // ── Transaction confirmation outcomes (issue #385) ────────────────────────
  /** Tracked transaction outcomes, by status (confirmed | expired | …). */
  public readonly txConfirmationOutcomes: client.Counter<string>;

  // ── Fee-bump escalations (issue #454) ─────────────────────────────────────
  /** Fee-bump transactions built, by inclusion-fee percentile. */
  public readonly txFeeBumpTotal: client.Counter<string>;
  /** Refusals to escalate past `maxFeeStroops` (page on any increase). */
  public readonly txFeeBumpCeilingHits: client.Counter<string>;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.register = new client.Registry();
    const prefix = "vortex_";

    this.httpRequestDuration = new client.Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code", "version"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });

    this.httpRequestTotal = new client.Counter({
      name: `${prefix}http_requests_total`,
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status_code", "version"],
      registers: [this.register],
    });

    this.httpRequestErrors = new client.Counter({
      name: `${prefix}http_request_errors_total`,
      help: "Total number of HTTP request errors (5xx)",
      labelNames: ["method", "route", "status_code", "version"],
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

    this.sweeperSafetyCaughtTotal = new client.Counter({
      name: `${prefix}sweeper_safety_caught_total`,
      help: "Intents expired or slashed by the low-frequency safety sweep (lost deadline jobs). Should stay near zero.",
      registers: [this.register],
    });

    // ── SLO SLIs (issue #480) ───────────────────────────────────────────────
    this.intentCreateDuration = new client.Histogram({
      name: `${prefix}intent_create_duration_seconds`,
      help: "Intent-create handler latency in seconds",
      labelNames: ["route"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.wsDeliveryDuration = new client.Histogram({
      name: `${prefix}ws_delivery_duration_seconds`,
      help: "WS end-to-end delivery latency (broadcast to send) in seconds",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.eventIngestionLag = new client.Gauge({
      name: `${prefix}event_ingestion_lag_seconds`,
      help: "Event-ingestion lag: now minus newest ingested event timestamp",
      registers: [this.register],
    });

    this.txConfirmationDuration = new client.Histogram({
      name: `${prefix}tx_confirmation_duration_seconds`,
      help: "Fill submission to on-chain confirmation latency in seconds",
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers: [this.register],
    });

    // ── WS capability-filter metrics (issue #436) ──────────────────────────
    this.wsEventsDeliveredTotal = new client.Counter({
      name: `${prefix}ws_events_delivered_total`,
      help: "WS events delivered to authenticated solvers after capability filtering",
      labelNames: ["solver"],
      registers: [this.register],
    });

    this.wsEventsFilteredTotal = new client.Counter({
      name: `${prefix}ws_events_filtered_total`,
      help: "WS events suppressed by capability filter (intent outside solver's chains/tokens)",
      labelNames: ["solver"],
      registers: [this.register],
    });

    // ── Restore-transaction metrics (issue #394) ───────────────────────────
    this.sorobanRestoreTotal = new client.Counter({
      name: `${prefix}soroban_restore_total`,
      help: "Total RestoreFootprint transactions submitted",
      labelNames: ["result"],
      registers: [this.register],
    });

    this.sorobanRestoreFeeStroops = new client.Histogram({
      name: `${prefix}soroban_restore_fee_stroops`,
      help: "Fee paid for RestoreFootprint transactions in stroops",
      buckets: [1000, 5000, 10000, 50000, 100000, 500000, 1000000],
      registers: [this.register],
    });

    // ── Remote signer latency (issue #400) ────────────────────────────────
    this.signerCallDurationSeconds = new client.Histogram({
      name: `${prefix}signer_call_duration_seconds`,
      help: "Remote signer call latency in seconds",
      labelNames: ["backend", "operation"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    // ── Solver-registry event ingestion (issue #399) ──────────────────────
    this.solverRegistryEventsTotal = new client.Counter({
      name: `${prefix}solver_registry_events_total`,
      help: "Solver-registry contract events ingested by type",
      labelNames: ["event_type"],
      registers: [this.register],
    });

    this.legacyStellarSignatures = new client.Counter({
      name: `${prefix}legacy_stellar_signatures_total`,
      help: "Accepted version 1 Stellar intent signatures during the deprecation window",
      labelNames: ["action"],
      registers: [this.register],
    });

    // ── Anti-griefing controls (issue #453) ────────────────────────────────
    this.griefingStateTransitionsTotal = new client.Counter({
      name: `${prefix}griefing_state_transitions_total`,
      help: "Anti-griefing enforcement state machine transitions per solver",
      labelNames: ["solver", "from_state", "to_state"],
      registers: [this.register],
    });

    this.griefingUnfilledRatio = new client.Gauge({
      name: `${prefix}griefing_unfilled_ratio`,
      help: "Current rolling unfilled-accept ratio for solvers under enforcement",
      labelNames: ["solver"],
      registers: [this.register],
    });

    this.griefingEnforcedSolvers = new client.Gauge({
      name: `${prefix}griefing_enforced_solvers`,
      help: "Number of solvers currently under anti-griefing enforcement (not in ok state)",
      registers: [this.register],
    });

    this.griefingEnforcementState = new client.Gauge({
      name: `${prefix}griefing_enforcement_state`,
      help: "1 when the solver is currently in the given enforcement state, 0 otherwise",
      labelNames: ["solver", "state"],
      registers: [this.register],
    });

    this.griefingConcurrencyLimit = new client.Gauge({
      name: `${prefix}griefing_concurrency_limit`,
      help: "Effective concurrent-accept cap per solver while in reduced-concurrency (0 = unlimited)",
      labelNames: ["solver"],
      registers: [this.register],
    });

    // ── Shadow-mode divergence monitor (issue #401) ──────────────────────────
    this.shadowComparisons = new client.Counter({
      name: `${prefix}shadow_comparisons_total`,
      help: "Shadow-mode (expected, simulated) outcome pairs resolved, by transition, expected outcome and simulated outcome",
      labelNames: ["transition", "expected", "outcome"],
      registers: [this.register],
    });

    this.shadowDivergences = new client.Counter({
      name: `${prefix}shadow_divergences_total`,
      help: "Shadow-mode divergences between the off-chain and simulated on-chain outcome, by transition and reason",
      labelNames: ["transition", "reason"],
      registers: [this.register],
    });

    this.shadowDropped = new client.Counter({
      name: `${prefix}shadow_dropped_total`,
      help: "Shadow-mode observations dropped because the bounded queue was full",
      registers: [this.register],
    });

    this.shadowQueueDepth = new client.Gauge({
      name: `${prefix}shadow_queue_depth`,
      help: "Current number of queued shadow-mode observations awaiting simulation",
      registers: [this.register],
    });

    // ── Leader election metrics (issue #493) ─────────────────────────────────
    this.leaderElectionIsLeader = new client.Gauge({
      name: `${prefix}leader_election_is_leader`,
      help: "1 when this replica is the current leader for the named worker, 0 otherwise",
      labelNames: ["worker"],
      registers: [this.register],
    });

    this.leaderElectionChangesTotal = new client.Counter({
      name: `${prefix}leader_election_changes_total`,
      help: "Total number of leadership transitions (acquisitions + losses) per worker",
      labelNames: ["worker", "transition"],
      registers: [this.register],
    });

    // ── Background jobs (issue #494) ────────────────────────────────────────
    // Depth is sampled on scrape from the active queue driver, so it reflects
    // every instance's shared view of the queue (BullMQ) without a timer.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.jobsQueueDepth = new client.Gauge({
      name: `${prefix}jobs_queue_depth`,
      help: "Jobs per queue and state (waiting, active, delayed, dead_letter)",
      labelNames: ["queue", "state"],
      registers: [this.register],
      async collect() {
        if (!self.queueDepthProvider) return;
        this.reset();
        for (const { queue, state, count } of await self.queueDepthProvider()) {
          this.set({ queue, state }, count);
        }
      },
    });

    this.jobsDuration = new client.Histogram({
      name: `${prefix}jobs_duration_seconds`,
      help: "Job handler latency in seconds",
      labelNames: ["queue", "job", "outcome"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
      registers: [this.register],
    });

    this.jobsFailures = new client.Counter({
      name: `${prefix}jobs_failures_total`,
      help: "Failed job attempts (including ones that will be retried)",
      labelNames: ["queue", "job"],
      registers: [this.register],
    });

    this.jobsDeadLettered = new client.Counter({
      name: `${prefix}jobs_dead_lettered_total`,
      help: "Jobs moved to the dead-letter queue after exhausting retries",
      labelNames: ["queue", "job"],
      registers: [this.register],
    });

    // ── Feature flags (issue #495) ──────────────────────────────────────────
    this.flagEvaluations = new client.Counter({
      name: `${prefix}flag_evaluations_total`,
      help: "Feature-flag evaluations by flag, resolved value and reason",
      labelNames: ["flag", "value", "reason"],
      registers: [this.register],
    });

    // ── WS backplane (issue #454) ────────────────────────────────────────────
    this.wsBackplanePublishDuration = new client.Histogram({
      name: `${prefix}ws_backplane_publish_duration_seconds`,
      help: "Time to sequence one WS event through the Redis backplane",
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
      registers: [this.register],
    });
    this.wsBackplaneDropped = new client.Counter({
      name: `${prefix}ws_backplane_dropped_total`,
      help: "WS events dropped by the backplane, by reason",
      labelNames: ["reason"],
      registers: [this.register],
    });
    this.wsBackplaneConnected = new client.Gauge({
      name: `${prefix}ws_backplane_connected`,
      help: "1 while this replica is reading from the Redis backplane",
      registers: [this.register],
    });

    // ── WS hardening (issue #455) ────────────────────────────────────────────
    this.wsConnectionsRejected = new client.Counter({
      name: `${prefix}ws_connections_rejected_total`,
      help: "WS connections refused at admission, by reason (max_connections, per_ip)",
      labelNames: ["reason"],
      registers: [this.register],
    });
    this.wsRateLimited = new client.Counter({
      name: `${prefix}ws_rate_limited_total`,
      help: "Inbound WS messages rejected by the per-connection token bucket, by action",
      labelNames: ["action"],
      registers: [this.register],
    });
    this.wsOutboundDropped = new client.Counter({
      name: `${prefix}ws_outbound_dropped_total`,
      help: "Outbound WS messages dropped for slow consumers (drop-oldest policy)",
      registers: [this.register],
    });
    this.wsSlowConsumerDisconnects = new client.Counter({
      name: `${prefix}ws_slow_consumer_disconnects_total`,
      help: "WS connections closed because their outbound queue exceeded its bound",
      registers: [this.register],
    });

    // ── Health (issue #492) ──────────────────────────────────────────────────
    this.healthIndicatorUp = new client.Gauge({
      name: `${prefix}health_indicator_up`,
      help: "1 when the named health indicator's last check passed, else 0",
      labelNames: ["indicator"],
      registers: [this.register],
    });
    this.healthReady = new client.Gauge({
      name: `${prefix}health_ready`,
      help: "1 when this replica reports ready (after hysteresis), else 0",
      registers: [this.register],
    });
    this.healthCheckDuration = new client.Histogram({
      name: `${prefix}health_check_duration_seconds`,
      help: "Duration of background health-indicator checks",
      labelNames: ["indicator"],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3],
      registers: [this.register],
    });

    // ── Dual-write / consistency verifier (issue #404) ───────────────────────
    this.intentsDualWriteFailuresTotal = new client.Counter({
      name: `${prefix}intents_dual_write_failures_total`,
      help: "Postgres mirror writes that failed while INTENTS_STORE=dual",
      labelNames: ["operation"],
      registers: [this.register],
    });

    this.intentsStoreMismatches = new client.Gauge({
      name: `${prefix}intents_store_mismatches`,
      help: "Mismatches between the memory and Postgres intent stores found by the last verifier run",
      labelNames: ["kind"],
      registers: [this.register],
    });

    this.intentsStoreMismatchesTotal = new client.Counter({
      name: `${prefix}intents_store_mismatches_total`,
      help: "Cumulative mismatches found by the dual-write consistency verifier",
      labelNames: ["kind"],
      registers: [this.register],
    });

    this.intentsStoreVerifierRunsTotal = new client.Counter({
      name: `${prefix}intents_store_verifier_runs_total`,
      help: "Completed dual-write consistency verifier runs",
      registers: [this.register],
    });

    // ── Contract version gating (issue #402) ─────────────────────────────────
    this.contractVersionSupported = new client.Gauge({
      name: `${prefix}contract_version_supported`,
      help: "1 when the deployed contract WASM maps to a supported ABI, 0 when writes are blocked",
      labelNames: ["contract"],
      registers: [this.register],
    });

    this.contractUpgradesTotal = new client.Counter({
      name: `${prefix}contract_upgrades_total`,
      help: "Contract WASM upgrades detected, by detection source (poll | event)",
      labelNames: ["contract", "source"],
      registers: [this.register],
    });

    this.contractWritesBlockedTotal = new client.Counter({
      name: `${prefix}contract_writes_blocked_total`,
      help: "On-chain writes refused because the contract version is unsupported",
      labelNames: ["contract"],
      registers: [this.register],
    });

    // ── Source-chain deposit verification (issue #403) ──────────────────────
    this.srcVerificationsTotal = new client.Counter({
      name: `${prefix}src_verifications_total`,
      help: "Source-deposit verification outcomes, by chain and status",
      labelNames: ["chain", "status"],
      registers: [this.register],
    });

    this.srcVerificationErrorsTotal = new client.Counter({
      name: `${prefix}src_verification_errors_total`,
      help: "Source-deposit verification attempts that failed with an RPC error",
      labelNames: ["chain", "reason"],
      registers: [this.register],
    });

    this.srcVerificationQueueSize = new client.Gauge({
      name: `${prefix}src_verification_queue_size`,
      help: "Open intents awaiting (re-)verification of their source deposit",
      registers: [this.register],
    });

    // ── Outbox relay (issue #396) ───────────────────────────────────────────
    this.outboxRelayOutcomes = new client.Counter({
      name: `${prefix}outbox_relay_outcomes_total`,
      help: "Outbox rows processed by the relay, by outcome (submitted|simulated|confirmed|retry|dead)",
      labelNames: ["outcome"],
      registers: [this.register],
    });

    this.outboxDeadTotal = new client.Counter({
      name: `${prefix}outbox_dead_total`,
      help: "Outbox rows moved to dead after exhausting OUTBOX_MAX_ATTEMPTS (page on any increase)",
      registers: [this.register],
    });

    this.outboxBacklog = new client.Gauge({
      name: `${prefix}outbox_rows`,
      help: "Current number of outbox rows by status",
      labelNames: ["status"],
      registers: [this.register],
    });

    // ── Slashing saga (issue #397) ──────────────────────────────────────────
    this.slashTransitions = new client.Counter({
      name: `${prefix}slash_pipeline_transitions_total`,
      help: "Pending-slash state transitions, by target state and reason",
      labelNames: ["to_state", "reason"],
      registers: [this.register],
    });

    // ── Channel pool (issue #473) ───────────────────────────────────────────
    this.channelLeaseWaitTime = new client.Histogram({
      name: `${prefix}channel_lease_wait_seconds`,
      help: "Seconds spent waiting for a channel lease",
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.register],
    });

    this.channelBadSeqResyncs = new client.Counter({
      name: `${prefix}channel_bad_seq_resyncs_total`,
      help: "Channel reconnects forced by a bad sequence number",
      registers: [this.register],
    });

    this.channelPoolUtilisation = new client.Gauge({
      name: `${prefix}channel_pool_utilisation`,
      help: "Fraction (0..1) of the channel pool currently leased",
      registers: [this.register],
    });

    // ── Transaction confirmation outcomes (issue #385) ──────────────────────
    this.txConfirmationOutcomes = new client.Counter({
      name: `${prefix}tx_confirmation_outcomes_total`,
      help: "Tracked transaction outcomes, by status",
      labelNames: ["status"],
      registers: [this.register],
    });

    // ── Fee-bump escalations (issue #454) ───────────────────────────────────
    this.txFeeBumpTotal = new client.Counter({
      name: `${prefix}tx_fee_bump_total`,
      help: "Fee-bump transactions built, by inclusion-fee percentile",
      labelNames: ["percentile"],
      registers: [this.register],
    });

    this.txFeeBumpCeilingHits = new client.Counter({
      name: `${prefix}tx_fee_bump_ceiling_hits_total`,
      help: "Refusals to escalate past the configured max fee (stroops/op)",
      registers: [this.register],
    });
  }

  /** Registers the source sampled for `vortex_jobs_queue_depth` on each scrape. */
  setQueueDepthProvider(
    provider: () => Promise<Array<{ queue: string; state: string; count: number }>>,
  ): void {
    this.queueDepthProvider = provider;
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

  /**
   * Items the safety sweep had to settle because a deadline job did not.
   * Called by IntentsSweeperService at the end of `sweep({ safety: true })`.
   */
  recordSafetyCatch(count: number): void {
    if (count > 0) this.sweeperSafetyCaughtTotal.inc(count);
  }

  /**
   * Observe intent-create latency (SLO SLI, issue #480).
   * Call from the create path with handler duration in seconds.
   */
  observeIntentCreate(durationSeconds: number, route = "POST /api/v1/intents"): void {
    this.intentCreateDuration.observe({ route }, durationSeconds);
  }

  /**
   * Observe WS end-to-end delivery latency (SLO SLI, issue #480).
   * Call from the gateway broadcast path with queue-to-send duration.
   */
  observeWsDelivery(durationSeconds: number): void {
    this.wsDeliveryDuration.observe(durationSeconds);
  }

  /** Set current event-ingestion lag in seconds (SLO SLI, issue #480). */
  setIngestionLag(lagSeconds: number): void {
    this.eventIngestionLag.set(lagSeconds);
  }

  /** Observe fill-to-confirmation latency in seconds (SLO SLI, issue #480). */
  observeTxConfirmation(durationSeconds: number): void {
    this.txConfirmationDuration.observe(durationSeconds);
  }

  // ── WS capability-filter helpers (issue #436) ────────────────────────────

  /** Record a WS event delivered to an authenticated solver (post-filter). */
  incWsDelivered(solverAddress: string): void {
    this.wsEventsDeliveredTotal.inc({ solver: solverAddress.slice(0, 12) });
  }

  /** Record a WS event suppressed for a solver by the capability filter. */
  incWsFiltered(solverAddress: string): void {
    this.wsEventsFilteredTotal.inc({ solver: solverAddress.slice(0, 12) });
  }

  // ── Restore-transaction helpers (issue #394) ──────────────────────────────

  incSorobanRestore(result: "success" | "failed"): void {
    this.sorobanRestoreTotal.inc({ result });
  }

  observeRestoreFee(stroops: number): void {
    this.sorobanRestoreFeeStroops.observe(stroops);
  }

  // ── Remote signer helpers (issue #400) ────────────────────────────────────

  observeSignerCall(backend: string, operation: string, durationSeconds: number): void {
    this.signerCallDurationSeconds.observe({ backend, operation }, durationSeconds);
  }

  // ── Solver-registry event ingestion helpers (issue #399) ─────────────────

  incSolverRegistryEvent(eventType: string): void {
    this.solverRegistryEventsTotal.inc({ event_type: eventType });
  }

  /**
   * Record one resolved shadow-mode comparison (issue #401).
   *
   * `expected` is the off-chain verdict and `outcome` the simulated one, so
   * the pair required by the issue stays queryable from PromQL:
   * `...{expected="ok",outcome="rejected"}` is the "contract would have
   * refused a transition we committed" case, and the reverse label pair is the
   * "we refused something the contract allows" case. Cardinality is bounded at
   * 5 transitions x 2 expected x 4 outcomes.
   *
   * `outcome` is `"unavailable"` when the simulation never produced a verdict
   * (unconfigured contract, RPC unreachable) so that case stays
   * distinguishable in PromQL from a contract that actively said no.
   */
  recordShadowComparison(transition: string, expected: string, outcome: string): void {
    this.shadowComparisons.inc({ transition, expected, outcome });
  }

  /** Record one classified shadow-mode divergence (issue #401). */
  recordShadowDivergence(transition: string, reason: string): void {
    this.shadowDivergences.inc({ transition, reason });
  }

  /** Record one shadow-mode observation dropped by the bounded queue. */
  recordShadowDrop(): void {
    this.shadowDropped.inc();
  }

  /** Publish the current shadow queue depth. */
  setShadowQueueDepth(depth: number): void {
    this.shadowQueueDepth.set(depth);
  }

  /**
   * Record that this replica acquired leadership for `workerName`.
   * Sets the is_leader gauge to 1 and increments the acquisition counter.
   */
  recordLeadershipAcquired(workerName: string): void {
    this.leaderElectionIsLeader.set({ worker: workerName }, 1);
    this.leaderElectionChangesTotal.inc({ worker: workerName, transition: "acquired" });
  }

  /**
   * Record that this replica lost leadership for `workerName`.
   * Sets the is_leader gauge to 0 and increments the lost counter.
   */
  recordLeadershipLost(workerName: string): void {
    this.leaderElectionIsLeader.set({ worker: workerName }, 0);
    this.leaderElectionChangesTotal.inc({ worker: workerName, transition: "lost" });
  }

  /** Count a Postgres mirror write that failed in dual-write mode. */
  recordDualWriteFailure(operation: string): void {
    this.intentsDualWriteFailuresTotal.inc({ operation });
  }

  /** Publish one consistency-verifier run's mismatch counts, keyed by kind. */
  recordStoreVerification(mismatches: Record<string, number>): void {
    this.intentsStoreVerifierRunsTotal.inc();
    for (const [kind, count] of Object.entries(mismatches)) {
      this.intentsStoreMismatches.set({ kind }, count);
      if (count > 0) this.intentsStoreMismatchesTotal.inc({ kind }, count);
    }
  }

  setContractVersionSupported(contract: string, supported: boolean): void {
    this.contractVersionSupported.set({ contract }, supported ? 1 : 0);
  }

  recordContractUpgrade(contract: string, source: "poll" | "event"): void {
    this.contractUpgradesTotal.inc({ contract, source });
  }

  recordContractWriteBlocked(contract: string): void {
    this.contractWritesBlockedTotal.inc({ contract });
  }

  recordSrcVerification(chain: string, status: string): void {
    this.srcVerificationsTotal.inc({ chain, status });
  }

  recordSrcVerificationError(chain: string, reason: "rate_limited" | "rpc_error"): void {
    this.srcVerificationErrorsTotal.inc({ chain, reason });
  }

  setSrcVerificationQueueSize(size: number): void {
    this.srcVerificationQueueSize.set(size);
  }

  /** One outbox row outcome; `dead` also feeds the alerting counter. */
  recordOutboxOutcome(outcome: "submitted" | "simulated" | "confirmed" | "retry" | "dead"): void {
    this.outboxRelayOutcomes.inc({ outcome });
    if (outcome === "dead") this.outboxDeadTotal.inc();
  }

  setOutboxBacklog(counts: Record<string, number>): void {
    for (const [status, count] of Object.entries(counts)) {
      this.outboxBacklog.set({ status }, count);
    }
  }

  recordSlashTransition(toState: string, reason = "none"): void {
    this.slashTransitions.inc({ to_state: toState, reason });
  }

  // ── Anti-griefing helpers (issue #453) ────────────────────────────────────

  /** Record one anti-griefing enforcement state-machine transition. */
  recordGriefingTransition(solverAddress: string, fromState: string, toState: string): void {
    this.griefingStateTransitionsTotal.inc({
      solver: solverAddress.slice(0, 12),
      from_state: fromState,
      to_state: toState,
    });
  }

  /** Update the rolling unfilled-accept ratio for a solver under enforcement. */
  setGriefingRatio(solverAddress: string, ratio: number): void {
    this.griefingUnfilledRatio.set({ solver: solverAddress.slice(0, 12) }, ratio);
  }

  /** Set the count of solvers currently under enforcement. */
  setGriefingEnforcedCount(count: number): void {
    this.griefingEnforcedSolvers.set(count);
  }

  /**
   * Update per-solver enforcement state gauges.
   *
   * Sets the named state label to 1 and all other enforcement states to 0
   * so dashboards can query `{state="suspended"}` without stale series.
   */
  setGriefingEnforcementState(solverAddress: string, state: string): void {
    const s = solverAddress.slice(0, 12);
    for (const st of ["ok", "cooldown", "reduced-concurrency", "suspended"]) {
      this.griefingEnforcementState.set({ solver: s, state: st }, st === state ? 1 : 0);
    }
  }

  /**
   * Update the effective concurrency cap for a solver.
   * Pass 0 when no limit is active (state is not "reduced-concurrency").
   */
  setGriefingConcurrencyLimit(solverAddress: string, limit: number): void {
    this.griefingConcurrencyLimit.set({ solver: solverAddress.slice(0, 12) }, limit);
  }
}
