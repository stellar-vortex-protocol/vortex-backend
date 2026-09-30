import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../metrics/metrics.service";
import {
  asShadowDivergenceReason,
  asShadowTransition,
  classifyDivergence,
  classifySimulationFailure,
  expectedOutcomeFromOffchain,
  type SimulationClassification,
} from "./shadow-divergence";
import {
  SHADOW_TRANSITIONS,
  type ShadowDayBucket,
  type ShadowDivergenceCell,
  type ShadowObservation,
  type ShadowOutcome,
  type ShadowQueueStats,
  type ShadowReport,
  type ShadowTransition,
  type ShadowTransitionSummary,
} from "./shadow.types";
import { StellarTxService } from "./stellar-tx.service";

/** What a caller hands to {@link ShadowService.observe}. */
export interface ShadowObservationRequest {
  transition: ShadowTransition;
  intentId: string;
  /**
   * True when the off-chain path committed the transition.
   *
   * This is the authoritative answer the simulation is compared against, so a
   * `false` here (a guard stopped the write) is a meaningful comparison: a
   * contract that would have *accepted* the operation is a real divergence.
   */
  committed: boolean;
  /** Settlement-contract method to simulate. */
  method: string;
  /** Already-encoded contract arguments. */
  args: xdr.ScVal[];
}

/** Internal queue entry: the request plus the expected outcome. */
interface QueuedShadowRequest {
  request: ShadowObservationRequest;
  expectedOutcome: ShadowOutcome;
}

/** Per-day accumulator, used to answer "divergence rate over N days". */
interface DayAccumulator {
  day: string;
  compared: number;
  diverged: number;
  /** `transition|reason` → count. */
  cells: Map<string, ShadowDivergenceCell>;
}

/**
 * How long to wait before draining the queue.
 *
 * A `setTimeout` rather than a microtask: a microtask would still run before
 * the request's response is flushed, so the p99 latency argument in the issue
 * would not hold. A macrotask yields to the event loop first, so the enqueue
 * itself is the only cost the request path pays.
 */
const DRAIN_DELAY_MS = 0;

/** Upper bound on `?days=` so one request cannot ask for unbounded history. */
export const MAX_SHADOW_REPORT_DAYS = 90;

/**
 * How many UTC days of buckets are kept in memory.
 *
 * Tied to {@link MAX_SHADOW_REPORT_DAYS} deliberately: retaining fewer buckets
 * than the report is allowed to request would let `?days=90` silently return a
 * short series, which during a cutover would look like "the monitor stopped
 * observing" rather than "the history was evicted".
 */
const MAX_RETAINED_DAYS = MAX_SHADOW_REPORT_DAYS;

/**
 * Shadow-mode divergence monitor (issue #401).
 *
 * ## What it does
 *
 * For every intent state transition the off-chain path commits, the service
 * *simulates* the equivalent settlement-contract call and records the pair
 * `(expected_outcome, simulated_outcome)`. Nothing is ever submitted: the only
 * RPC call used is `simulateTransaction`, which is read-only by construction.
 *
 * ## Guarantees the issue requires
 *
 * - **Never throws into the request path.** {@link observe} is synchronous,
 *   wrapped in its own try/catch, and touches no I/O. The simulation happens
 *   later, on a background drain.
 * - **Bounded memory.** The queue is a hard-capped ring; an observation
 *   arriving at a full queue increments a drop counter and is discarded. A
 *   slow or unreachable RPC therefore degrades the *monitor*, never the
 *   service.
 * - **Drops are visible.** Dropped, sampled-out, disabled and completed counts
 *   are all exported on both the report endpoint and Prometheus, so a starved
 *   monitor can never be mistaken for a healthy one.
 * - **No channel accounts consumed.** Simulations are unsigned and unbroadcast
 *   (see {@link StellarTxService.simulateContract}).
 *
 * ## Why it is off by default
 *
 * `SHADOW_MODE_ENABLED` defaults to `false`. A sampled simulation is a real RPC
 * call with real latency and a real rate-limit footprint, so it is an explicit
 * per-environment opt-in rather than something a deployer discovers they are
 * paying for. The cutover runbook's go/no-go threshold only means anything once
 * an environment has actually been running with it enabled.
 */
@Injectable()
export class ShadowService implements OnModuleDestroy {
  private readonly logger = new Logger(ShadowService.name);

  private readonly enabled: boolean;
  private readonly sampleRate: number;
  private readonly queueMax: number;
  private readonly concurrency: number;
  private readonly sourceAccount: string;
  private readonly contractId: string;

  /** Bounded FIFO. Shifted from the head on drain. */
  private queue: QueuedShadowRequest[] = [];

  /**
   * Observations handed to `simulateContract` but not yet recorded.
   *
   * Tracked separately from the queue because a batch is spliced out of the
   * queue *before* its `await`s resolve: without this counter the published
   * depth would read 0 while up to `concurrency` simulations were in flight,
   * and the `VortexShadowMonitorStarved` alert would see a healthy monitor at
   * exactly the moment the RPC is slowest.
   */
  private inFlight = 0;

  /** Monotonic guard so at most one drain timer is outstanding at a time. */
  private drainScheduled = false;
  /** Monotonic guard so at most one drain loop is running at a time. */
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set in {@link onModuleDestroy}. Latches every write path off: a drain that
   * is already awaiting an RPC must not record against a torn-down metrics
   * registry when it resumes.
   */
  private shuttingDown = false;

  private disabledCount = 0;
  private sampledOutCount = 0;
  private droppedCount = 0;
  private completedCount = 0;

  /** Lifetime totals, used for the whole-window summary. */
  private comparedCount = 0;
  private divergedCount = 0;
  private readonly transitionCounts = new Map<ShadowTransition, { compared: number; diverged: number }>();
  private readonly divergenceCells = new Map<string, ShadowDivergenceCell>();
  private readonly days = new Map<string, DayAccumulator>();

  constructor(
    private readonly stellarTxService: StellarTxService,
    private readonly metricsService: MetricsService,
    configService: ConfigService<AppConfig, true>,
  ) {
    const shadow = configService.get("shadow", { infer: true });
    this.enabled = shadow.enabled;
    this.sampleRate = shadow.sampleRate;
    this.queueMax = shadow.queueMax;
    this.concurrency = shadow.concurrency;
    this.sourceAccount = shadow.sourceAccount;
    this.contractId = configService.get("stellar.settlementContractId", { infer: true });

    for (const transition of SHADOW_TRANSITIONS) {
      this.transitionCounts.set(transition, { compared: 0, diverged: 0 });
    }
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    // Drop anything still queued: pending work would otherwise try to record
    // observations against torn-down metrics during shutdown. Anything already
    // in flight is abandoned by the `shuttingDown` latch in `record()`.
    this.queue = [];
  }

  /** Whether the monitor is currently accepting observations. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Decide whether the monitor wants to observe one more transition, and do the
   * accounting for the answer.
   *
   * Callers MUST ask this *before* doing any work that only exists to feed the
   * monitor — a repository read to rebuild contract arguments, XDR encoding —
   * because the sampling draw happens here and nowhere else. Doing it inside
   * `observe()` instead would mean paying for that work on every transition
   * only to discard most of them.
   *
   * The disabled and sampled-out counters are bumped here, which is what makes
   * "the monitor is dark" visible on the report endpoint: with sampling inside
   * `observe()`, a disabled monitor is never called and `disabled` would read 0
   * forever, indistinguishable from a healthy monitor that sampled everything.
   */
  shouldObserve(): boolean {
    try {
      if (!this.enabled) {
        this.disabledCount += 1;
        return false;
      }
      if (this.sampleRate < 1 && Math.random() >= this.sampleRate) {
        this.sampledOutCount += 1;
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`[shadow] shouldObserve() failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Record that `request` was observed off-chain, and schedule a simulation to
   * be compared against it.
   *
   * Sampling has already been decided by {@link shouldObserve}; this method
   * does not draw again.
   *
   * Synchronous and side-effect-free with respect to I/O: the whole method body
   * is a set of counter bumps, an array push and a timer schedule. It is
   * wrapped in try/catch so that a bug in this file can never surface as a
   * failed intent transition.
   *
   * Cost target: the issue's load-test criterion is a p99 latency delta under
   * 2 ms; `shadow.service.spec.ts` asserts the synchronous path stays in the
   * low microseconds.
   */
  observe(request: ShadowObservationRequest): void {
    try {
      if (this.shuttingDown) {
        this.countDrop(request, "shutting down");
        return;
      }

      if (this.queue.length >= this.queueMax) {
        this.countDrop(request, `queue full (capacity=${this.queueMax})`);
        return;
      }

      this.queue.push({
        request,
        expectedOutcome: expectedOutcomeFromOffchain(request.committed),
      });
      this.publishQueueDepth();
      this.scheduleDrain();
    } catch (err) {
      // Defensive: the monitor is observability, never a correctness
      // dependency. Swallow and keep the request path clean.
      this.logger.error(`[shadow] observe() failed, discarding: ${(err as Error).message}`);
    }
  }

  /**
   * Account for an observation that will not be simulated, and say so.
   *
   * A drop is a hole in the evidence the cutover decision rests on, so it is
   * counted and logged rather than silently discarded — a monitor that is
   * quietly dropping half its observations reports a divergence rate that means
   * nothing.
   */
  private countDrop(request: ShadowObservationRequest, cause: string): void {
    this.droppedCount += 1;
    this.metricsService.recordShadowDrop();
    this.logger.warn(
      `[shadow] dropped transition=${request.transition} intent=${request.intentId}: ${cause}`,
    );
  }

  /**
   * Schedule a background drain of the queue.
   *
   * At most one timer is outstanding at a time, and none is armed while a drain
   * is already running: the loop below re-checks the queue between batches, so
   * a second concurrent drain would only reorder observations and double-count
   * the queue depth.
   */
  private scheduleDrain(): void {
    if (this.drainScheduled || this.draining || this.shuttingDown) return;
    this.drainScheduled = true;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainScheduled = false;
      void this.drain();
    }, DRAIN_DELAY_MS);
    // Never hold the process open just to finish shadow comparisons.
    this.drainTimer.unref?.();
  }

  /**
   * Simulate up to `concurrency` queued observations concurrently, repeating
   * until the queue empties or shutdown begins.
   *
   * Exposed for tests so they can await a deterministic drain instead of
   * racing the timer. Re-entrant calls return immediately rather than running a
   * second loop over the same queue.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.shuttingDown) {
        const batch = this.queue.splice(0, this.concurrency);
        this.inFlight += batch.length;
        this.publishQueueDepth();
        // Each observation is isolated: one bad classification must not reject
        // the whole batch and silently lose the rest of it.
        await Promise.all(
          batch.map((entry) =>
            this.process(entry).catch((err: unknown) => {
              this.logger.error(
                `[shadow] could not process an observation: ${(err as Error).message}`,
              );
            }),
          ),
        );
        this.inFlight -= batch.length;
        this.publishQueueDepth();
      }
    } finally {
      this.draining = false;
      this.publishQueueDepth();
      // An observation enqueued while the last batch was in flight still needs
      // a drain, and the loop above may have exited on `shuttingDown`.
      if (this.queue.length > 0 && !this.shuttingDown) this.scheduleDrain();
    }
  }

  /**
   * Publish queued + in-flight work as the queue-depth gauge.
   *
   * Skipped during shutdown: the registry may already be torn down, and the
   * process is exiting, so a gauge write is pure risk.
   */
  private publishQueueDepth(): void {
    if (this.shuttingDown) return;
    this.metricsService.setShadowQueueDepth(this.queue.length + this.inFlight);
  }

  /**
   * Simulate one queued request and record the resulting comparison.
   *
   * Failures are classified, never rethrown: an RPC outage must show up as a
   * `simulation_exception` divergence count, not as an unhandled rejection.
   */
  private async process(entry: QueuedShadowRequest): Promise<void> {
    const { request, expectedOutcome } = entry;

    let simulated: SimulationClassification | null;
    try {
      const result = await this.stellarTxService.simulateContract({
        contractId: this.contractId,
        method: request.method,
        args: request.args,
        sourceAccount: this.sourceAccount,
      });

      // `skipped` means we never obtained a verdict because the monitor is not
      // configured (unconfigured contract or source account). That is
      // represented as a `null` simulation so the classifier reports
      // `contract_unconfigured` rather than `simulation_exception` — the
      // difference between "the contract disagrees with us" and "there was no
      // contract to ask".
      //
      // `unavailable` is the other no-verdict case, this time ours: the RPC was
      // unreachable. It maps to `threw: true` so it is counted as
      // `simulation_exception`, and it must not be reported as the contract
      // having failed.
      if (result.outcome === "skipped") {
        simulated = null;
      } else {
        const outcome: ShadowOutcome =
          result.outcome === "ok" || result.outcome === "rejected" || result.outcome === "error"
            ? result.outcome
            : "error";
        simulated = {
          outcome,
          threw: result.outcome === "unavailable",
          ...(result.detail ? { detail: result.detail } : {}),
        };
      }
    } catch (err) {
      // `simulateContract` folds its own failures into the result, so reaching
      // here means an unexpected throw (a bug, or a transport-level rejection).
      // Classify it rather than letting it escape the drain.
      simulated = classifySimulationFailure(err);
    }

    const reason = classifyDivergence(expectedOutcome, simulated);
    const simulatedOutcome: ShadowOutcome | null =
      simulated === null || simulated.threw ? null : simulated.outcome;

    this.record({
      transition: request.transition,
      intentId: request.intentId,
      expectedOutcome,
      simulatedOutcome,
      reason,
      ...(simulated?.detail ? { detail: simulated.detail } : {}),
      observedAt: new Date().toISOString(),
    });
  }

  /**
   * Fold one completed comparison into the lifetime totals, the daily buckets,
   * and the Prometheus counters. Synchronous and allocation-light.
   */
  private record(observation: ShadowObservation): void {
    if (this.shuttingDown) {
      // A drain that was mid-`await` when the module was destroyed. The
      // observation is lost with the process, which is exactly what we want:
      // writing to a torn-down registry would turn a clean shutdown into an
      // unhandled rejection.
      return;
    }

    // The declared types already constrain both labels, but narrowing them here
    // means an unexpected value can never create a new metric-cardinality
    // series or a new map key. Belt and braces on a label that ends up in
    // Prometheus is worth it. An unknown label is counted as a drop rather than
    // vanishing: it must still show up in the totals, otherwise the report
    // would not add up.
    const transition = asShadowTransition(observation.transition);
    if (transition === null) {
      this.droppedCount += 1;
      this.metricsService.recordShadowDrop();
      this.logger.error(
        `[shadow] discarded observation with unknown transition label "${observation.transition}"`,
      );
      return;
    }

    this.comparedCount += 1;
    this.completedCount += 1;

    const perTransition = this.transitionCounts.get(transition);
    if (perTransition) {
      perTransition.compared += 1;
    }

    const day = this.currentDay();
    day.compared += 1;

    // Both sides of the pair are exported, not just the simulated one: the issue
    // asks for `(expected_outcome, simulated_outcome)` per transition, and
    // without the `expected` label the counter cannot answer "in which
    // direction does the contract disagree?" — `rejected` on both sides and
    // `ok`/`rejected` are indistinguishable divergences.
    this.metricsService.recordShadowComparison(
      transition,
      observation.expectedOutcome,
      observation.simulatedOutcome ?? "unavailable",
    );

    if (observation.reason === null) return;

    const reason = asShadowDivergenceReason(observation.reason);
    if (reason === null) return;

    this.divergedCount += 1;
    if (perTransition) {
      perTransition.diverged += 1;
    }
    day.diverged += 1;

    const cellKey = `${transition}|${reason}`;
    const existing = this.divergenceCells.get(cellKey);
    if (existing) {
      existing.count += 1;
    } else {
      this.divergenceCells.set(cellKey, {
        transition,
        reason,
        count: 1,
      });
    }

    const dayCell = day.cells.get(cellKey);
    if (dayCell) {
      dayCell.count += 1;
    } else {
      day.cells.set(cellKey, {
        transition,
        reason,
        count: 1,
      });
    }

    this.metricsService.recordShadowDivergence(transition, reason);

    this.logger.warn(
      `[shadow] divergence transition=${transition} reason=${reason} ` +
        `expected=${observation.expectedOutcome} simulated=${observation.simulatedOutcome ?? "none"} ` +
        `intent=${observation.intentId}${observation.detail ? ` detail="${observation.detail}"` : ""}`,
    );
  }

  /** The UTC-day accumulator for today, creating and evicting as needed. */
  private currentDay(): DayAccumulator {
    const key = new Date().toISOString().slice(0, 10);
    const existing = this.days.get(key);
    if (existing) return existing;

    const created: DayAccumulator = { day: key, compared: 0, diverged: 0, cells: new Map() };
    this.days.set(key, created);

    // Bound memory: drop the oldest day once the retention cap is exceeded.
    if (this.days.size > MAX_RETAINED_DAYS) {
      const oldest = this.days.keys().next();
      if (!oldest.done) {
        this.days.delete(oldest.value);
      }
    }
    return created;
  }

  /** Snapshot of queue health for the report and for tests. */
  queueStats(): ShadowQueueStats {
    return {
      depth: this.queue.length + this.inFlight,
      // The effective bound: the queue itself plus the batch a drain has
      // already spliced out of it. Reporting `queueMax` alone would make a
      // monitor sitting at its true limit look over-full.
      capacity: this.queueMax + this.concurrency,
      dropped: this.droppedCount,
      sampledOut: this.sampledOutCount,
      disabled: this.disabledCount,
      completed: this.completedCount,
    };
  }

  /**
   * Build the daily summary served by `GET /api/v1/admin/shadow-report`.
   *
   * `days` selects how many trailing UTC days of per-day breakdown to include
   * (the headline totals are always lifetime-to-date — a go/no-go decision is
   * about the whole soak, not one day of it). Values are clamped rather than
   * rejected so a monitoring probe can never get a 400 in the middle of an
   * incident.
   */
  report(days = 1): ShadowReport {
    const requestedDays = Math.min(
      Math.max(Math.trunc(Number.isFinite(days) ? days : 1), 1),
      MAX_SHADOW_REPORT_DAYS,
    );

    const transitions: ShadowTransitionSummary[] = SHADOW_TRANSITIONS.map((transition) => {
      const counts = this.transitionCounts.get(transition) ?? { compared: 0, diverged: 0 };
      return {
        transition,
        compared: counts.compared,
        diverged: counts.diverged,
        divergenceRate: ratio(counts.diverged, counts.compared),
      };
    });

    const divergences = [...this.divergenceCells.values()].sort(
      (a, b) => b.count - a.count || a.transition.localeCompare(b.transition) || a.reason.localeCompare(b.reason),
    );

    const daily: ShadowDayBucket[] = [...this.days.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-requestedDays)
      .map((accumulator) => ({
        day: accumulator.day,
        compared: accumulator.compared,
        diverged: accumulator.diverged,
        divergenceRate: ratio(accumulator.diverged, accumulator.compared),
        cells: [...accumulator.cells.values()].sort(
          (a, b) => b.count - a.count || a.transition.localeCompare(b.transition),
        ),
      }));

    return {
      enabled: this.enabled,
      sampleRate: this.sampleRate,
      day: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      compared: this.comparedCount,
      diverged: this.divergedCount,
      divergenceRate: ratio(this.divergedCount, this.comparedCount),
      transitions,
      divergences,
      daily,
      queue: this.queueStats(),
    };
  }
}

/** Safe division — an unobserved window has a rate of 0, not `NaN`. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}
