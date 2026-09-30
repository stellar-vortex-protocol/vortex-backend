import { LeaderElectionService } from "./leader-election.service";
import { LeaderElectionBackend } from "./leader-election.types";

/**
 * Unit tests for LeaderElectionService (issue #493).
 *
 * All tests use an in-memory backend stub — no real DB required.
 * The heartbeat timer is driven via jest.useFakeTimers() for deterministic
 * time control, and runHeartbeatOnce() is used to fire individual ticks.
 */

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMockBackend(defaults: {
  tryAcquireResult?: number | null;
  renewResult?: boolean;
} = {}): jest.Mocked<LeaderElectionBackend> {
  // Use explicit 'in' check so that null is treated as a real "return null" value,
  // not as "unset" (which would fall through to the default of 1).
  const acquireReturn = "tryAcquireResult" in defaults ? defaults.tryAcquireResult! : 1;
  return {
    tryAcquire: jest.fn().mockResolvedValue(acquireReturn),
    renew: jest.fn().mockResolvedValue(defaults.renewResult ?? true),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(
  backend: LeaderElectionBackend,
  heartbeatIntervalMs = 5_000,
): LeaderElectionService {
  // Pass undefined for metricsService (optional @Optional dep)
  return new LeaderElectionService(backend, undefined, heartbeatIntervalMs);
}

// ─── registerWorker ───────────────────────────────────────────────────────────

describe("LeaderElectionService — registerWorker", () => {
  it("initialises state as not-leader before first heartbeat", () => {
    const service = makeService(makeMockBackend());
    service.registerWorker("sweeper", jest.fn());

    const state = service.getState("sweeper");
    expect(state).toBeDefined();
    expect(state!.isLeader).toBe(false);
    expect(state!.fencingToken).toBeNull();
    expect(state!.acquiredAt).toBeNull();
    expect(state!.acquisitionCount).toBe(0);
  });

  it("isLeader() returns false before first heartbeat", () => {
    const service = makeService(makeMockBackend());
    service.registerWorker("sweeper", jest.fn());
    expect(service.isLeader("sweeper")).toBe(false);
  });

  it("isLeader() returns false for an unregistered worker", () => {
    const service = makeService(makeMockBackend());
    expect(service.isLeader("unknown-worker")).toBe(false);
  });

  it("accepts multiple callbacks for the same worker name", () => {
    const service = makeService(makeMockBackend());
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    service.registerWorker("sweeper", cb1);
    service.registerWorker("sweeper", cb2);
    // getAllStates has exactly one entry for the worker
    expect(Object.keys(service.getAllStates())).toHaveLength(1);
  });
});

// ─── promotion (lock acquisition) ─────────────────────────────────────────────

describe("LeaderElectionService — promotion", () => {
  it("calls tryAcquire on the first heartbeat for each registered worker", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1 });
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());
    service.registerWorker("event-ingestion", jest.fn());

    await service.runHeartbeatOnce();

    expect(backend.tryAcquire).toHaveBeenCalledWith("sweeper");
    expect(backend.tryAcquire).toHaveBeenCalledWith("event-ingestion");
  });

  it("marks the worker as leader when tryAcquire returns a token", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 7 });
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce();

    expect(service.isLeader("sweeper")).toBe(true);
    expect(service.getState("sweeper")!.fencingToken).toBe(7);
  });

  it("invokes the callback with (true, token) on promotion", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 42 });
    const service = makeService(backend);
    const callback = jest.fn();
    service.registerWorker("sweeper", callback);

    await service.runHeartbeatOnce();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(true, 42);
  });

  it("invokes all registered callbacks on promotion", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1 });
    const service = makeService(backend);
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    service.registerWorker("sweeper", cb1);
    service.registerWorker("sweeper", cb2);

    await service.runHeartbeatOnce();

    expect(cb1).toHaveBeenCalledWith(true, 1);
    expect(cb2).toHaveBeenCalledWith(true, 1);
  });

  it("sets acquiredAt to an ISO timestamp on promotion", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1 });
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());

    const before = new Date().toISOString();
    await service.runHeartbeatOnce();
    const after = new Date().toISOString();

    const { acquiredAt } = service.getState("sweeper")!;
    expect(acquiredAt).not.toBeNull();
    expect(new Date(acquiredAt!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(acquiredAt!).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it("increments acquisitionCount on each promotion", async () => {
    let shouldAcquire = true;
    const backend: jest.Mocked<LeaderElectionBackend> = {
      tryAcquire: jest.fn().mockImplementation(() =>
        Promise.resolve(shouldAcquire ? 1 : null),
      ),
      renew: jest.fn().mockImplementation(() => Promise.resolve(shouldAcquire)),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce(); // 1st acquisition
    expect(service.getState("sweeper")!.acquisitionCount).toBe(1);

    // lose the lock
    shouldAcquire = false;
    await service.runHeartbeatOnce(); // renew fails → demote

    // re-acquire
    shouldAcquire = true;
    await service.runHeartbeatOnce();
    expect(service.getState("sweeper")!.acquisitionCount).toBe(2);
  });

  it("does not call tryAcquire again while already leader (calls renew instead)", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1, renewResult: true });
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce(); // acquire
    await service.runHeartbeatOnce(); // renew
    await service.runHeartbeatOnce(); // renew

    expect(backend.tryAcquire).toHaveBeenCalledTimes(1);
    expect(backend.renew).toHaveBeenCalledTimes(2);
  });

  it("does not re-fire callback while leadership is continuously held", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1, renewResult: true });
    const service = makeService(backend);
    const callback = jest.fn();
    service.registerWorker("sweeper", callback);

    await service.runHeartbeatOnce(); // acquires → callback(true, 1)
    await service.runHeartbeatOnce(); // renews → no callback

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not promote when tryAcquire returns null (another replica holds the lock)", async () => {
    const backend = makeMockBackend({ tryAcquireResult: null });
    const service = makeService(backend);
    const callback = jest.fn();
    service.registerWorker("sweeper", callback);

    await service.runHeartbeatOnce();

    expect(service.isLeader("sweeper")).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });
});

// ─── demotion (lock loss) ──────────────────────────────────────────────────────

describe("LeaderElectionService — demotion", () => {
  it("demotes when renew returns false", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 3, renewResult: true });
    const service = makeService(backend);
    const callback = jest.fn();
    service.registerWorker("sweeper", callback);

    await service.runHeartbeatOnce(); // acquire, callback(true, 3)
    backend.renew.mockResolvedValue(false);
    await service.runHeartbeatOnce(); // renew fails → demote, callback(false, null)

    expect(service.isLeader("sweeper")).toBe(false);
    expect(service.getState("sweeper")!.fencingToken).toBeNull();
    expect(service.getState("sweeper")!.acquiredAt).toBeNull();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(false, null);
  });

  it("re-acquires on the next heartbeat after demotion if the lock is free", async () => {
    let token = 1;
    let shouldRenew = true;
    const backend: jest.Mocked<LeaderElectionBackend> = {
      tryAcquire: jest.fn().mockImplementation(() => Promise.resolve(token++)),
      renew: jest.fn().mockImplementation(() => Promise.resolve(shouldRenew)),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeService(backend);
    const callback = jest.fn();
    service.registerWorker("sweeper", callback);

    await service.runHeartbeatOnce(); // acquire with token=1
    shouldRenew = false;
    await service.runHeartbeatOnce(); // demote
    await service.runHeartbeatOnce(); // re-acquire with token=2

    expect(service.isLeader("sweeper")).toBe(true);
    expect(service.getState("sweeper")!.fencingToken).toBe(2);
    expect(callback).toHaveBeenCalledTimes(3); // promote, demote, promote
  });
});

// ─── multiple workers ──────────────────────────────────────────────────────────

describe("LeaderElectionService — multiple workers", () => {
  it("tracks independent state per worker", async () => {
    const backend: jest.Mocked<LeaderElectionBackend> = {
      tryAcquire: jest.fn().mockImplementation((name: string) =>
        Promise.resolve(name === "sweeper" ? 10 : null),
      ),
      renew: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeService(backend);
    const sweeperCb = jest.fn();
    const ingestCb = jest.fn();
    service.registerWorker("sweeper", sweeperCb);
    service.registerWorker("event-ingestion", ingestCb);

    await service.runHeartbeatOnce();

    expect(service.isLeader("sweeper")).toBe(true);
    expect(service.isLeader("event-ingestion")).toBe(false);
    expect(sweeperCb).toHaveBeenCalledWith(true, 10);
    expect(ingestCb).not.toHaveBeenCalled();
  });

  it("getAllStates() includes all registered workers", () => {
    const service = makeService(makeMockBackend());
    service.registerWorker("sweeper", jest.fn());
    service.registerWorker("event-ingestion", jest.fn());

    const states = service.getAllStates();

    expect(Object.keys(states)).toContain("sweeper");
    expect(Object.keys(states)).toContain("event-ingestion");
    expect(Object.keys(states)).toHaveLength(2);
  });
});

// ─── onModuleDestroy ───────────────────────────────────────────────────────────

describe("LeaderElectionService — onModuleDestroy", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("clears the heartbeat timer so no further backend calls are made", async () => {
    const backend = makeMockBackend({ tryAcquireResult: null });
    const service = makeService(backend, 1_000);
    service.registerWorker("sweeper", jest.fn());
    service.onModuleInit();

    service.onModuleDestroy();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(backend.tryAcquire).not.toHaveBeenCalled();
  });

  it("calls backend.release for workers where this replica is leader", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 5 });
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce(); // acquire token=5
    service.onModuleDestroy();
    await Promise.resolve();

    expect(backend.release).toHaveBeenCalledWith("sweeper", 5);
  });

  it("does not call backend.release for workers not held by this replica", async () => {
    const backend = makeMockBackend({ tryAcquireResult: null });
    const service = makeService(backend);
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce(); // never acquired
    service.onModuleDestroy();
    await Promise.resolve();

    expect(backend.release).not.toHaveBeenCalled();
  });
});

// ─── heartbeat timer ───────────────────────────────────────────────────────────

describe("LeaderElectionService — heartbeat timer (fake timers)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("fires tryAcquire on the configured interval", async () => {
    const backend = makeMockBackend({ tryAcquireResult: null });
    const service = makeService(backend, 1_000);
    service.registerWorker("sweeper", jest.fn());
    service.onModuleInit();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();

    expect(backend.tryAcquire).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it("fires multiple heartbeats proportional to elapsed time", async () => {
    const backend = makeMockBackend({ tryAcquireResult: null });
    const service = makeService(backend, 1_000);
    service.registerWorker("sweeper", jest.fn());
    service.onModuleInit();

    jest.advanceTimersByTime(3_000);
    await Promise.resolve();

    expect(backend.tryAcquire).toHaveBeenCalledTimes(3);
    service.onModuleDestroy();
  });
});

// ─── metrics integration ───────────────────────────────────────────────────────

describe("LeaderElectionService — metrics integration", () => {
  it("calls recordLeadershipAcquired when promoted", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1 });
    const metricsService = {
      recordLeadershipAcquired: jest.fn(),
      recordLeadershipLost: jest.fn(),
    };
    const service = new LeaderElectionService(
      backend,
      metricsService as never,
      5_000,
    );
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce();

    expect(metricsService.recordLeadershipAcquired).toHaveBeenCalledWith("sweeper");
    expect(metricsService.recordLeadershipLost).not.toHaveBeenCalled();
  });

  it("calls recordLeadershipLost when demoted", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1, renewResult: true });
    const metricsService = {
      recordLeadershipAcquired: jest.fn(),
      recordLeadershipLost: jest.fn(),
    };
    const service = new LeaderElectionService(
      backend,
      metricsService as never,
      5_000,
    );
    service.registerWorker("sweeper", jest.fn());

    await service.runHeartbeatOnce(); // promote
    backend.renew.mockResolvedValue(false);
    await service.runHeartbeatOnce(); // demote

    expect(metricsService.recordLeadershipLost).toHaveBeenCalledWith("sweeper");
  });

  it("does not throw when metricsService is undefined (optional dep)", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1 });
    const service = new LeaderElectionService(backend, undefined, 5_000);
    service.registerWorker("sweeper", jest.fn());

    await expect(service.runHeartbeatOnce()).resolves.not.toThrow();
  });
});

// ─── callback error isolation ──────────────────────────────────────────────────

describe("LeaderElectionService — callback error isolation", () => {
  it("continues notifying remaining callbacks if one throws", async () => {
    const backend = makeMockBackend({ tryAcquireResult: 1 });
    const service = makeService(backend);
    const cb1 = jest.fn().mockImplementation(() => { throw new Error("cb1 boom"); });
    const cb2 = jest.fn();
    service.registerWorker("sweeper", cb1);
    service.registerWorker("sweeper", cb2);

    // Should not propagate cb1's error
    await expect(service.runHeartbeatOnce()).resolves.not.toThrow();
    expect(cb2).toHaveBeenCalledWith(true, 1);
  });
});
