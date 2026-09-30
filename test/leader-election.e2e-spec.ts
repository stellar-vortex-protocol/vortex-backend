/**
 * Leader election — single-active-worker assertion (issue #493).
 *
 * These tests validate the core guarantee of the leader election design:
 * at most one replica is leader for a given worker at any point in time,
 * and a failed leader is replaced within the configured failover window.
 *
 * Architecture
 * ────────────
 * Because the production backend uses Postgres advisory locks (which require
 * a live database), we test the guarantee at the service layer using an
 * in-process "shared lock store" that accurately models Postgres advisory-lock
 * semantics:
 *
 *   - Only one holder per worker name (mutex).
 *   - Lock is session-scoped: dropped when the holder calls release() OR when
 *     the holder's connection is marked as "dead".
 *   - Fencing token is monotonically incremented on each acquisition.
 *
 * Two or more LeaderElectionService instances share this lock store, each
 * representing a separate replica running in-process.  This is the exact same
 * logical path the production code takes — only the I/O is mocked.
 *
 * Test coverage
 * ─────────────
 *  1. With two replicas, exactly one holds leadership at a time.
 *  2. When the leader releases its lock, the follower takes over on the next
 *     heartbeat (failover within FAILOVER_BUDGET_MS).
 *  3. After failover, the new leader has a higher fencing token than the old one.
 *  4. Graceful shutdown (onModuleDestroy) releases the lock immediately so
 *     the standby can take over without waiting for TTL expiry.
 */

import { LeaderElectionService } from "../src/common/leader-election/leader-election.service";
import { LeaderElectionBackend } from "../src/common/leader-election/leader-election.types";

// ─── Shared in-memory lock store (models Postgres advisory locks) ──────────────

interface LockEntry {
  holder: string; // replica id
  fence: number;
}

/**
 * A shared lock table that enforces the mutex invariant.
 * All backend instances for a given test share the same Map.
 */
class SharedLockStore {
  private readonly locks = new Map<string, LockEntry>();
  private readonly fences = new Map<string, number>(); // persists across releases

  tryAcquire(workerName: string, replicaId: string): number | null {
    if (this.locks.has(workerName)) return null;
    const fence = (this.fences.get(workerName) ?? 0) + 1;
    this.fences.set(workerName, fence);
    this.locks.set(workerName, { holder: replicaId, fence });
    return fence;
  }

  renew(workerName: string, replicaId: string, fence: number): boolean {
    const entry = this.locks.get(workerName);
    if (!entry) return false;
    return entry.holder === replicaId && entry.fence === fence;
  }

  release(workerName: string, replicaId: string): void {
    const entry = this.locks.get(workerName);
    if (entry?.holder === replicaId) {
      this.locks.delete(workerName);
    }
  }

  /** Force-drop a lock (simulates process crash / connection drop). */
  forceRelease(workerName: string): void {
    this.locks.delete(workerName);
  }

  holder(workerName: string): string | undefined {
    return this.locks.get(workerName)?.holder;
  }

  fence(workerName: string): number | undefined {
    return this.locks.get(workerName)?.fence;
  }
}

/** Build a backend backed by the shared store. */
function makeSharedBackend(store: SharedLockStore, replicaId: string): LeaderElectionBackend {
  return {
    tryAcquire: jest.fn().mockImplementation((workerName: string) =>
      Promise.resolve(store.tryAcquire(workerName, replicaId)),
    ),
    renew: jest.fn().mockImplementation((workerName: string, fence: number) =>
      Promise.resolve(store.renew(workerName, replicaId, fence)),
    ),
    release: jest.fn().mockImplementation((workerName: string) => {
      store.release(workerName, replicaId);
      return Promise.resolve();
    }),
  };
}

/** Build a LeaderElectionService with the shared backend. */
function makeReplica(
  store: SharedLockStore,
  replicaId: string,
  heartbeatMs = 10,
): { service: LeaderElectionService; replicaId: string } {
  const backend = makeSharedBackend(store, replicaId);
  const service = new LeaderElectionService(backend, undefined, heartbeatMs);
  return { service, replicaId };
}

/** Wait up to `ms` for a predicate to become true, checking every 10 ms. */
async function waitFor(predicate: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${ms} ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Leader election — single-active-worker guarantee", () => {
  const HEARTBEAT_MS = 10; // fast heartbeat so failover is quick in tests
  const FAILOVER_BUDGET_MS = 500; // ≈ 50× heartbeat — generous for CI

  // ── invariant: at most one leader ─────────────────────────────────────────

  it("exactly one of two replicas becomes leader for a given worker", async () => {
    const store = new SharedLockStore();
    const { service: r1 } = makeReplica(store, "replica-1", HEARTBEAT_MS);
    const { service: r2 } = makeReplica(store, "replica-2", HEARTBEAT_MS);

    r1.registerWorker("sweeper", jest.fn());
    r2.registerWorker("sweeper", jest.fn());

    r1.onModuleInit();
    r2.onModuleInit();

    // Wait for exactly one replica to be leader
    await waitFor(
      () => r1.isLeader("sweeper") !== r2.isLeader("sweeper"),
      FAILOVER_BUDGET_MS,
    );

    // Invariant: exactly one leader
    expect(r1.isLeader("sweeper") || r2.isLeader("sweeper")).toBe(true);
    expect(r1.isLeader("sweeper") && r2.isLeader("sweeper")).toBe(false);

    r1.onModuleDestroy();
    r2.onModuleDestroy();
  });

  it("three replicas — still exactly one leader", async () => {
    const store = new SharedLockStore();
    const replicas = ["r1", "r2", "r3"].map((id) =>
      makeReplica(store, id, HEARTBEAT_MS),
    );

    for (const { service } of replicas) {
      service.registerWorker("sweeper", jest.fn());
      service.onModuleInit();
    }

    await waitFor(
      () => replicas.filter(({ service }) => service.isLeader("sweeper")).length === 1,
      FAILOVER_BUDGET_MS,
    );

    const leaders = replicas.filter(({ service }) => service.isLeader("sweeper"));
    expect(leaders).toHaveLength(1);

    for (const { service } of replicas) service.onModuleDestroy();
  });

  // ── failover after leader release ─────────────────────────────────────────

  it("follower takes over within failover budget after leader gracefully shuts down", async () => {
    const store = new SharedLockStore();
    const { service: leader } = makeReplica(store, "leader", HEARTBEAT_MS);
    const { service: follower } = makeReplica(store, "follower", HEARTBEAT_MS);

    leader.registerWorker("sweeper", jest.fn());
    follower.registerWorker("sweeper", jest.fn());

    leader.onModuleInit();
    follower.onModuleInit();

    // Wait for leader to acquire
    await waitFor(() => leader.isLeader("sweeper"), FAILOVER_BUDGET_MS);
    expect(follower.isLeader("sweeper")).toBe(false);

    const leaderCb = jest.fn();
    const followerCb = jest.fn();
    leader.registerWorker("sweeper", leaderCb);
    follower.registerWorker("sweeper", followerCb);

    // Kill the leader — releases the lock but the leader's heartbeat also stops,
    // so its in-memory isLeader flag is not reset. That's fine: the important
    // guarantee is that the standby takes over, not that the dead replica
    // is self-aware of its demotion.
    leader.onModuleDestroy();

    // Follower should take over
    await waitFor(() => follower.isLeader("sweeper"), FAILOVER_BUDGET_MS);

    expect(follower.isLeader("sweeper")).toBe(true);

    follower.onModuleDestroy();
  });

  it("follower takes over within failover budget after leader crashes (lock force-dropped)", async () => {
    const store = new SharedLockStore();
    const { service: leader } = makeReplica(store, "leader", HEARTBEAT_MS);
    const { service: follower } = makeReplica(store, "follower", HEARTBEAT_MS);

    const leaderCb = jest.fn();
    const followerCb = jest.fn();
    leader.registerWorker("sweeper", leaderCb);
    follower.registerWorker("sweeper", followerCb);

    leader.onModuleInit();
    follower.onModuleInit();

    // Wait for leader to acquire
    await waitFor(() => leader.isLeader("sweeper"), FAILOVER_BUDGET_MS);

    // Simulate crash: force-drop the lock (like a dead pg connection)
    store.forceRelease("sweeper");

    // Leader's next renew() will return false → it demotes itself
    await waitFor(() => !leader.isLeader("sweeper"), FAILOVER_BUDGET_MS);

    // Follower should then acquire
    await waitFor(() => follower.isLeader("sweeper"), FAILOVER_BUDGET_MS);

    expect(follower.isLeader("sweeper")).toBe(true);

    leader.onModuleDestroy();
    follower.onModuleDestroy();
  });

  // ── fencing token monotonicity ────────────────────────────────────────────

  it("fencing token is strictly higher after failover than before", async () => {
    const store = new SharedLockStore();
    const { service: r1 } = makeReplica(store, "r1", HEARTBEAT_MS);
    const { service: r2 } = makeReplica(store, "r2", HEARTBEAT_MS);

    r1.registerWorker("sweeper", jest.fn());
    r2.registerWorker("sweeper", jest.fn());

    r1.onModuleInit();
    r2.onModuleInit();

    // Wait for one of them to be leader
    await waitFor(
      () => r1.isLeader("sweeper") || r2.isLeader("sweeper"),
      FAILOVER_BUDGET_MS,
    );

    const [firstLeader, standby] = r1.isLeader("sweeper") ? [r1, r2] : [r2, r1];
    const firstToken = firstLeader.getState("sweeper")!.fencingToken!;

    // Kill first leader
    store.forceRelease("sweeper");
    await waitFor(() => !firstLeader.isLeader("sweeper"), FAILOVER_BUDGET_MS);

    // Wait for standby to take over
    await waitFor(() => standby.isLeader("sweeper"), FAILOVER_BUDGET_MS);
    const secondToken = standby.getState("sweeper")!.fencingToken!;

    expect(secondToken).toBeGreaterThan(firstToken);

    r1.onModuleDestroy();
    r2.onModuleDestroy();
  });

  // ── callbacks ─────────────────────────────────────────────────────────────

  it("worker callbacks are invoked on promotion and demotion", async () => {
    const store = new SharedLockStore();
    const { service: r1 } = makeReplica(store, "r1", HEARTBEAT_MS);

    const cb = jest.fn();
    r1.registerWorker("sweeper", cb);
    r1.onModuleInit();

    // Promotion
    await waitFor(() => r1.isLeader("sweeper"), FAILOVER_BUDGET_MS);
    expect(cb).toHaveBeenCalledWith(true, expect.any(Number));

    // Force demotion
    store.forceRelease("sweeper");
    await waitFor(() => !r1.isLeader("sweeper"), FAILOVER_BUDGET_MS);
    expect(cb).toHaveBeenCalledWith(false, null);

    r1.onModuleDestroy();
  });

  // ── independent workers don't interfere ──────────────────────────────────

  it("two different workers are independently elected without interference", async () => {
    const store = new SharedLockStore();
    const { service: r1 } = makeReplica(store, "r1", HEARTBEAT_MS);
    const { service: r2 } = makeReplica(store, "r2", HEARTBEAT_MS);

    r1.registerWorker("sweeper", jest.fn());
    r1.registerWorker("event-ingestion", jest.fn());
    r2.registerWorker("sweeper", jest.fn());
    r2.registerWorker("event-ingestion", jest.fn());

    r1.onModuleInit();
    r2.onModuleInit();

    // Both workers should have exactly one leader
    await waitFor(
      () =>
        (r1.isLeader("sweeper") !== r2.isLeader("sweeper")) &&
        (r1.isLeader("event-ingestion") !== r2.isLeader("event-ingestion")),
      FAILOVER_BUDGET_MS,
    );

    // sweeper invariant
    expect(r1.isLeader("sweeper") && r2.isLeader("sweeper")).toBe(false);
    expect(r1.isLeader("sweeper") || r2.isLeader("sweeper")).toBe(true);

    // event-ingestion invariant
    expect(r1.isLeader("event-ingestion") && r2.isLeader("event-ingestion")).toBe(false);
    expect(r1.isLeader("event-ingestion") || r2.isLeader("event-ingestion")).toBe(true);

    r1.onModuleDestroy();
    r2.onModuleDestroy();
  });

  // ── no-op backend (LEADER_ELECTION_ENABLED=false) ─────────────────────────

  it("no-op backend (disabled) makes every replica consider itself leader", async () => {
    const noopBackend: LeaderElectionBackend = {
      tryAcquire: jest.fn().mockResolvedValue(1),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const s1 = new LeaderElectionService(noopBackend, undefined, HEARTBEAT_MS);
    const s2 = new LeaderElectionService(noopBackend, undefined, HEARTBEAT_MS);

    s1.registerWorker("sweeper", jest.fn());
    s2.registerWorker("sweeper", jest.fn());

    s1.onModuleInit();
    s2.onModuleInit();

    // Both think they're leader — acceptable when election is disabled
    await waitFor(() => s1.isLeader("sweeper"), FAILOVER_BUDGET_MS);
    await waitFor(() => s2.isLeader("sweeper"), FAILOVER_BUDGET_MS);

    expect(s1.isLeader("sweeper")).toBe(true);
    expect(s2.isLeader("sweeper")).toBe(true);

    s1.onModuleDestroy();
    s2.onModuleDestroy();
  });
});
