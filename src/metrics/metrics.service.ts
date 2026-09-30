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

  /**
   * Sweeper metrics — these replace the retired src/common/metrics.ts
   * MetricsRegistry.sweeper namespace (see issue #259).
   *
   * The on-call runbook (docs/runbooks/on-call.md) references these names
   * directly. Any change here must be reflected there.
   */
  public readonly sweeperExpiredTotal: client.Counter<string>;
  public readonly sweeperSweepDurationMs: client.Histogram<string>;

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

  // ── Anti-griefing controls (issue #453) ───────────────────────────────────
  /**
   * Tiers applied per solver (`action` = cooldown | concurrency_cap |
   * suspended | recovered | manual_reset). Label `solver` is truncated to 12
   * chars, matching the capability-filter metrics, to bound cardinality.
   */
  public readonly antiGriefingActions: client.Counter<string>;
  /**
   * Accept attempts refused by an anti-griefing control, labelled by the
   * machine-readable error code returned to the client (3 values, so this
   * counter's cardinality is fixed).
   */
  public readonly antiGriefingBlocked: client.Counter<string>;
  /** Rolling unfilled-accept ratio last observed per solver, in `[0, 1]`. */
  public readonly antiGriefingUnfilledRatio: client.Gauge<string>;
  /** Failures excused because they fell inside an admin-declared incident. */
  public readonly antiGriefingIncidentsExcluded: client.Counter<string>;

  // ── Remote signer call latency (issue #400) ───────────────────────────────
  public readonly signerCallDurationSeconds: client.Histogram<string>;

  // ── Solver-registry event ingestion (issue #399) ──────────────────────────
  public readonly solverRegistryEventsTotal: client.Counter<string>;

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

    // ── Anti-griefing controls (issue #453) ───────────────────────────────────
    this.antiGriefingActions = new client.Counter({
      name: `${prefix}antigriefing_actions_total`,
      help: "Anti-griefing tiers applied per solver (issue #453)",
      labelNames: ["solver", "action"],
      registers: [this.register],
    });

    this.antiGriefingBlocked = new client.Counter({
      name: `${prefix}antigriefing_blocked_total`,
      help: "Accept attempts refused by an anti-griefing control, by error code",
      labelNames: ["code"],
      registers: [this.register],
    });

    this.antiGriefingUnfilledRatio = new client.Gauge({
      name: `${prefix}antigriefing_unfilled_ratio`,
      help: "Rolling unfilled-accept ratio per solver (issue #453)",
      labelNames: ["solver"],
      registers: [this.register],
    });

    this.antiGriefingIncidentsExcluded = new client.Counter({
      name: `${prefix}antigriefing_incidents_excluded_total`,
      help: "Unfilled accepts excluded from the ratio because they fell in an admin incident",
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

  // ── Anti-griefing helpers (issue #453) ─────────────────────────────────────

  /** Record an anti-griefing tier applied to (or lifted from) a solver. */
  incAntiGriefingAction(solverAddress: string, action: string): void {
    this.antiGriefingActions.inc({ solver: solverAddress.slice(0, 12), action });
  }

  /** Record an accept refused by an anti-griefing control. */
  incAntiGriefingBlocked(code: string): void {
    this.antiGriefingBlocked.inc({ code });
  }

  /** Publish a solver's rolling unfilled-accept ratio for dashboards. */
  setAntiGriefingRatio(solverAddress: string, ratio: number): void {
    this.antiGriefingUnfilledRatio.set({ solver: solverAddress.slice(0, 12) }, ratio);
  }

  /** Record a failure excused by an admin-declared incident. */
  incAntiGriefingIncidentExcluded(): void {
    this.antiGriefingIncidentsExcluded.inc();
  }
}
