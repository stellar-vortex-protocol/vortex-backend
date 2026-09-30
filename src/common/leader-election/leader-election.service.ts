import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { MetricsService } from "../../metrics/metrics.service";
import {
  LEADER_ELECTION_BACKEND,
  LeaderElectionBackend,
  LeadershipState,
} from "./leader-election.types";

/**
 * Heartbeat interval at which the leader renews its lock and non-leaders
 * attempt to acquire.
 *
 * Kept short (5 s) so failover happens within 3 × heartbeat ≈ 15 s even
 * in the worst case where one heartbeat is delayed by a GC pause.
 *
 * Can be overridden via the LEADER_ELECTION_HEARTBEAT_MS env var — see
 * LeaderElectionModule.forRoot() which reads the config and passes it in.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Callback signature for workers that want to react to leadership changes.
 *
 * @param isLeader   True when this replica just became leader, false on demotion.
 * @param fencingToken The current fencing token, or null on demotion. Workers
 *                     SHOULD pass this token to every DB write they perform so a
 *                     stale leader's writes can be detected and rejected.
 */
export type LeadershipCallback = (isLeader: boolean, fencingToken: number | null) => void;

/**
 * LeaderElectionService
 * ─────────────────────
 * Coordinates leader election for named singleton workers using a pluggable
 * backend (Postgres advisory lock by default, K8s Lease optionally).
 *
 * Workers register themselves via `registerWorker()` and supply a callback
 * that is invoked whenever their leadership status changes. The service runs
 * a single heartbeat loop that periodically tries to acquire or renew each
 * registered lock.
 *
 * Usage
 * ─────
 *   // In a worker service:
 *   constructor(private readonly election: LeaderElectionService) {}
 *
 *   onModuleInit() {
 *     this.election.registerWorker('sweeper', (isLeader, token) => {
 *       if (isLeader) this.startPolling(token);
 *       else          this.stopPolling();
 *     });
 *   }
 *
 * Fencing tokens
 * ──────────────
 * Each time a new leader is elected the token is incremented. Workers should
 * include the token in any DB writes they perform (e.g. as a WHERE condition
 * on an optimistic-lock column) so writes from a stale leader are rejected
 * before they can corrupt shared state.
 *
 * Split-brain protection
 * ──────────────────────
 * On every heartbeat the current leader re-verifies it still holds the lock.
 * A GC pause that causes a missed heartbeat will result in the lock being
 * acquired by another replica; the stale leader will detect this on its next
 * heartbeat and call the callback with `isLeader=false`.
 *
 * @see PostgresAdvisoryLockBackend
 */
@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);

  /** All registered worker names → their current leadership state. */
  private readonly states = new Map<string, LeadershipState>();
  /** Callbacks registered by workers. */
  private readonly callbacks = new Map<string, LeadershipCallback[]>();
  /** Single heartbeat interval driving all registered workers. */
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    @Inject(LEADER_ELECTION_BACKEND)
    private readonly backend: LeaderElectionBackend,
    @Optional() private readonly metricsService?: MetricsService,
    private readonly heartbeatIntervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
  ) {}

  onModuleInit() {
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) =>
        this.logger.error(`[leader-election] heartbeat error: ${(err as Error).message}`),
      );
    }, this.heartbeatIntervalMs);
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Release all locks on graceful shutdown so a sibling replica can take
    // over immediately without waiting for TTL expiry.
    const releases = [...this.states.entries()]
      .filter(([, s]) => s.isLeader && s.fencingToken !== null)
      .map(([name, s]) =>
        this.backend
          .release(name, s.fencingToken!)
          .catch((err) =>
            this.logger.warn(
              `[leader-election] release on shutdown failed for "${name}": ${(err as Error).message}`,
            ),
          ),
      );
    // Best-effort — we can't await in a sync lifecycle hook.
    Promise.all(releases).catch(() => undefined);
  }

  /**
   * Register a worker for leader election.
   *
   * The callback will be invoked on the next heartbeat when leadership is
   * acquired. Multiple callbacks can be registered for the same worker.
   *
   * @param workerName  Unique stable name for this worker (e.g. 'sweeper').
   * @param callback    Called with `(true, token)` on promotion and
   *                    `(false, null)` on demotion.
   */
  registerWorker(workerName: string, callback: LeadershipCallback): void {
    if (!this.states.has(workerName)) {
      this.states.set(workerName, {
        isLeader: false,
        fencingToken: null,
        acquiredAt: null,
        acquisitionCount: 0,
      });
    }
    const existing = this.callbacks.get(workerName) ?? [];
    existing.push(callback);
    this.callbacks.set(workerName, existing);
    this.logger.log(`[leader-election] registered worker "${workerName}"`);
  }

  /** Return the current leadership state for the given worker. */
  getState(workerName: string): LeadershipState | undefined {
    return this.states.get(workerName);
  }

  /** True if this replica is the current leader for the given worker. */
  isLeader(workerName: string): boolean {
    return this.states.get(workerName)?.isLeader ?? false;
  }

  /** Expose all registered worker states (for health/metrics endpoints). */
  getAllStates(): Record<string, LeadershipState> {
    return Object.fromEntries(this.states.entries());
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /** Exposed for testing — runs one heartbeat tick immediately. */
  async runHeartbeatOnce(): Promise<void> {
    await this.heartbeat();
  }

  private async heartbeat(): Promise<void> {
    for (const [workerName, state] of this.states.entries()) {
      await this.tick(workerName, state);
    }
  }

  private async tick(workerName: string, state: LeadershipState): Promise<void> {
    if (state.isLeader) {
      // Already leader — renew the lock to prove we're still alive.
      const stillLeader = await this.backend.renew(workerName, state.fencingToken!);
      if (!stillLeader) {
        this.logger.warn(
          `[leader-election] lost leadership for "${workerName}" (lock not renewed) — demoting`,
        );
        this.demote(workerName, state);
      }
    } else {
      // Not leader — try to acquire.
      const token = await this.backend.tryAcquire(workerName);
      if (token !== null) {
        this.promote(workerName, state, token);
      }
    }
  }

  private promote(workerName: string, state: LeadershipState, token: number): void {
    state.isLeader = true;
    state.fencingToken = token;
    state.acquiredAt = new Date().toISOString();
    state.acquisitionCount++;
    this.logger.log(
      `[leader-election] this replica is now leader for "${workerName}" ` +
        `fencingToken=${token} acquisitionCount=${state.acquisitionCount}`,
    );
    this.metricsService?.recordLeadershipAcquired(workerName);
    this.notifyCallbacks(workerName, true, token);
  }

  private demote(workerName: string, state: LeadershipState): void {
    state.isLeader = false;
    state.fencingToken = null;
    state.acquiredAt = null;
    this.metricsService?.recordLeadershipLost(workerName);
    this.notifyCallbacks(workerName, false, null);
  }

  private notifyCallbacks(
    workerName: string,
    isLeader: boolean,
    fencingToken: number | null,
  ): void {
    for (const cb of this.callbacks.get(workerName) ?? []) {
      try {
        cb(isLeader, fencingToken);
      } catch (err) {
        this.logger.error(
          `[leader-election] callback for "${workerName}" threw: ${(err as Error).message}`,
        );
      }
    }
  }
}
