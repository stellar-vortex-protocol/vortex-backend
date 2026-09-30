/**
 * Unit tests for PostgresAdvisoryLockBackend (issue #493).
 *
 * The real pg.Client is replaced with a controllable mock so no live DB is
 * needed. We verify the backend sends the expected SQL and maps query results
 * to the correct return values.
 */

// ─── Setup pg mock ─────────────────────────────────────────────────────────────

// A single stable mock client object shared across all `new Client()` calls.
// This approach avoids `clearAllMocks` resetting the factory's returned value.
const mockPgClient = {
  connect: jest.fn(),
  end: jest.fn(),
  query: jest.fn(),
  on: jest.fn(),
};

jest.mock("pg", () => ({
  Client: jest.fn(() => mockPgClient),
}));

// Import AFTER mock is registered.
import { PostgresAdvisoryLockBackend } from "./postgres-advisory-lock.backend";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeBackend(): PostgresAdvisoryLockBackend {
  return new PostgresAdvisoryLockBackend(
    "postgresql://vortex:vortex@localhost:5432/vortex",
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPgClient.connect.mockResolvedValue(undefined);
  mockPgClient.end.mockResolvedValue(undefined);
  mockPgClient.on.mockReturnValue(undefined);
});

// ─── tryAcquire ────────────────────────────────────────────────────────────────

describe("PostgresAdvisoryLockBackend — tryAcquire", () => {
  it("returns a fencing token when the advisory lock is acquired", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })                          // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })        // pg_try_advisory_lock
      .mockResolvedValueOnce({ rows: [{ fence: "5" }] });           // upsert fence

    const token = await backend.tryAcquire("sweeper");

    expect(token).toBe(5);
  });

  it("returns null when the lock is held by another replica", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired: false }] });

    const token = await backend.tryAcquire("sweeper");

    expect(token).toBeNull();
  });

  it("returns null when the pg client throws", async () => {
    const backend = makeBackend();
    mockPgClient.query.mockRejectedValue(new Error("connection refused"));

    const token = await backend.tryAcquire("sweeper");

    expect(token).toBeNull();
  });

  it("issues pg_try_advisory_lock SQL", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "1" }] });

    await backend.tryAcquire("sweeper");

    const calls = mockPgClient.query.mock.calls as [string, ...unknown[]][];
    const lockCall = calls.find(([sql]) => sql.includes("pg_try_advisory_lock"));
    expect(lockCall).toBeDefined();
  });

  it("creates vortex_leader_election table on first call", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "1" }] });

    await backend.tryAcquire("sweeper");

    const calls = mockPgClient.query.mock.calls as [string, ...unknown[]][];
    const createCall = calls.find(([sql]) =>
      sql.includes("CREATE TABLE IF NOT EXISTS vortex_leader_election"),
    );
    expect(createCall).toBeDefined();
  });

  it("does not issue CREATE TABLE on subsequent calls (cached)", async () => {
    const backend = makeBackend();

    // First call — includes CREATE TABLE
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })                          // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "1" }] });
    await backend.tryAcquire("sweeper");

    // Second call — table already ensured
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "2" }] });
    await backend.tryAcquire("sweeper");

    const calls = mockPgClient.query.mock.calls as [string, ...unknown[]][];
    const createCalls = calls.filter(([sql]) => sql.includes("CREATE TABLE"));
    expect(createCalls).toHaveLength(1);
  });

  it("returns null when connect fails", async () => {
    const backend = makeBackend();
    mockPgClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const token = await backend.tryAcquire("sweeper");

    expect(token).toBeNull();
  });
});

// ─── renew ─────────────────────────────────────────────────────────────────────

describe("PostgresAdvisoryLockBackend — renew", () => {
  it("returns true when the DB fence matches the held token", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })                     // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ fence: "7" }] });      // SELECT fence

    const result = await backend.renew("sweeper", 7);

    expect(result).toBe(true);
  });

  it("returns false when the DB fence differs (stale leader)", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ fence: "8" }] });       // newer fence

    const result = await backend.renew("sweeper", 7);

    expect(result).toBe(false);
  });

  it("returns false when no row exists for the worker", async () => {
    const backend = makeBackend();
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });                     // no row

    const result = await backend.renew("sweeper", 1);

    expect(result).toBe(false);
  });

  it("returns false when query throws", async () => {
    const backend = makeBackend();
    mockPgClient.query.mockRejectedValue(new Error("network timeout"));

    const result = await backend.renew("sweeper", 1);

    expect(result).toBe(false);
  });
});

// ─── release ───────────────────────────────────────────────────────────────────

describe("PostgresAdvisoryLockBackend — release", () => {
  it("calls pg_advisory_unlock after acquiring the lock", async () => {
    const backend = makeBackend();

    // First establish connection via tryAcquire
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "1" }] });
    await backend.tryAcquire("sweeper");

    // Release
    mockPgClient.query.mockResolvedValueOnce({ rows: [] });
    await backend.release("sweeper", 1);

    const calls = mockPgClient.query.mock.calls as [string, ...unknown[]][];
    const unlockCall = calls.find(([sql]) => sql.includes("pg_advisory_unlock"));
    expect(unlockCall).toBeDefined();
  });

  it("is a no-op when not connected", async () => {
    const backend = makeBackend();
    // Never connected — release must not throw and must not call query
    await backend.release("sweeper", 1);

    expect(mockPgClient.query).not.toHaveBeenCalled();
  });
});

// ─── onModuleDestroy ───────────────────────────────────────────────────────────

describe("PostgresAdvisoryLockBackend — onModuleDestroy", () => {
  it("ends the pg client connection", async () => {
    const backend = makeBackend();

    // Establish connection first
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "1" }] });
    await backend.tryAcquire("sweeper");

    await backend.onModuleDestroy();

    expect(mockPgClient.end).toHaveBeenCalledTimes(1);
  });

  it("does not throw when not connected", async () => {
    const backend = makeBackend();
    await expect(backend.onModuleDestroy()).resolves.not.toThrow();
  });
});

// ─── connection error recovery ─────────────────────────────────────────────────

describe("PostgresAdvisoryLockBackend — connection error recovery", () => {
  it("reconnects on next tryAcquire after a connection failure", async () => {
    const backend = makeBackend();

    // First call: connect throws
    mockPgClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const tokenFirst = await backend.tryAcquire("sweeper");
    expect(tokenFirst).toBeNull();

    // Second call: connect succeeds, lock acquired
    mockPgClient.connect.mockResolvedValueOnce(undefined);
    mockPgClient.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ fence: "2" }] });

    const tokenSecond = await backend.tryAcquire("sweeper");
    expect(tokenSecond).toBe(2);
  });
});
