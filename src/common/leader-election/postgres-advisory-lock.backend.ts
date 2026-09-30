import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Client } from "pg";
import { LeaderElectionBackend } from "./leader-election.types";

/**
 * Postgres advisory-lock backend for LeaderElectionService.
 *
 * Uses a **dedicated** `pg.Client` connection (not the Prisma connection pool
 * and not PgBouncer in transaction mode) because Postgres advisory locks are
 * session-scoped — they are automatically released when the connection drops,
 * giving us free failover without a separate TTL heartbeat for the lock itself.
 *
 * Architecture note
 * ─────────────────
 * DO NOT route this through PgBouncer in transaction-pooling mode. Advisory
 * locks are held for the lifetime of the session; a transaction-pooled
 * connection may be returned to the pool between calls, releasing the lock
 * unexpectedly. Use a direct TCP connection or PgBouncer in session mode.
 *
 * Lock key derivation
 * ───────────────────
 * Postgres advisory-lock keys are a pair of 32-bit integers or a single
 * 64-bit integer. We derive a stable 32-bit key from the worker name using a
 * simple djb2 hash so no migration is required to add new workers.
 *
 * Fencing tokens
 * ──────────────
 * We use the `vortex_leader_election` table to store monotonically increasing
 * per-worker fence counters. The token is atomically incremented on each
 * acquisition via an upsert. Workers include the token in DB writes so a
 * stale leader's writes can be detected and rejected.
 *
 * Failover
 * ────────
 * When the leader process dies the `pg.Client` connection drops, releasing the
 * advisory lock. The next candidate calling tryAcquire() will obtain the lock
 * within one heartbeat interval (LEADER_ELECTION_HEARTBEAT_MS, default 5 s),
 * giving < 15 s failover end-to-end.
 */
@Injectable()
export class PostgresAdvisoryLockBackend implements LeaderElectionBackend, OnModuleDestroy {
  private readonly logger = new Logger(PostgresAdvisoryLockBackend.name);
  private client: Client | null = null;
  private connected = false;
  private tableEnsured = false;
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  /** Lazily connect on first use so the module can boot without a DB. */
  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) return;

    this.client = new Client({ connectionString: this.databaseUrl });
    try {
      await this.client.connect();
      this.connected = true;
      this.tableEnsured = false;
      this.logger.log("PostgresAdvisoryLockBackend: dedicated connection established");

      // Reconnect on unexpected disconnects so we don't get stuck in a
      // permanently-disconnected state.
      this.client.on("error", (err) => {
        this.logger.error(
          `PostgresAdvisoryLockBackend: connection error — will reconnect on next attempt: ${err.message}`,
        );
        this.connected = false;
        this.client = null;
        this.tableEnsured = false;
      });
    } catch (err) {
      this.connected = false;
      this.client = null;
      this.tableEnsured = false;
      throw err;
    }
  }

  /**
   * Ensure the `vortex_leader_election` table exists. Called once on first
   * use so there is no migration dependency; idempotent.
   */
  private async ensureTable(): Promise<void> {
    if (this.tableEnsured) return;
    await this.client!.query(`
      CREATE TABLE IF NOT EXISTS vortex_leader_election (
        worker_name  TEXT PRIMARY KEY,
        fence        BIGINT NOT NULL DEFAULT 0,
        holder       TEXT,
        acquired_at  TIMESTAMPTZ
      )
    `);
    this.tableEnsured = true;
  }

  /**
   * Derive a stable 32-bit key from `workerName` using djb2.
   * Combines into a 64-bit key for pg_try_advisory_lock(bigint).
   * Returned as a string because pg driver handles bigint as string.
   */
  private hashWorkerName(workerName: string): string {
    let hash = 5381n;
    for (const char of workerName) {
      hash = (hash * 33n + BigInt(char.charCodeAt(0))) & 0xffffffffn;
    }
    // Combine into a 64-bit key: put the hash in both halves.
    const combined = (hash << 32n) | hash;
    // Convert to signed 64-bit range for Postgres compatibility
    const max64 = 9223372036854775807n;
    const signed = combined > max64 ? combined - 18446744073709551616n : combined;
    return signed.toString();
  }

  async tryAcquire(workerName: string): Promise<number | null> {
    try {
      await this.ensureConnected();
      await this.ensureTable();

      const lockKey = this.hashWorkerName(workerName);

      // Try to grab the session-scoped advisory lock (non-blocking).
      const lockResult = await this.client!.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [lockKey],
      );
      const acquired = lockResult.rows[0]?.acquired;
      if (!acquired) return null;

      // We hold the lock — atomically bump the fencing token.
      const fenceResult = await this.client!.query<{ fence: string }>(
        `INSERT INTO vortex_leader_election (worker_name, fence, holder, acquired_at)
         VALUES ($1, 1, $2, NOW())
         ON CONFLICT (worker_name) DO UPDATE
           SET fence = vortex_leader_election.fence + 1,
               holder = EXCLUDED.holder,
               acquired_at = NOW()
         RETURNING fence`,
        [workerName, process.env.HOSTNAME ?? "unknown"],
      );

      const fence = parseInt(fenceResult.rows[0]?.fence ?? "1", 10);
      this.logger.log(
        `[leader-election] acquired lock for worker="${workerName}" fencingToken=${fence}`,
      );
      return fence;
    } catch (err) {
      this.logger.warn(
        `[leader-election] tryAcquire failed for worker="${workerName}": ${(err as Error).message}`,
      );
      // Treat DB errors as lock-not-acquired so the worker stays stopped.
      this.connected = false;
      this.client = null;
      this.tableEnsured = false;
      return null;
    }
  }

  async renew(workerName: string, fencingToken: number): Promise<boolean> {
    try {
      await this.ensureConnected();
      await this.ensureTable();
      // For the session advisory lock, as long as the connection is alive
      // the lock is held. We verify we still hold it by checking the fence
      // matches what we expect in the tracking table.
      const result = await this.client!.query<{ fence: string }>(
        `SELECT fence FROM vortex_leader_election WHERE worker_name = $1`,
        [workerName],
      );
      if (!result.rows.length) return false;
      const dbFence = parseInt(result.rows[0].fence, 10);
      // If the fence we hold matches the DB, we are still the acknowledged leader.
      return dbFence === fencingToken;
    } catch (err) {
      this.logger.warn(
        `[leader-election] renew failed for worker="${workerName}": ${(err as Error).message}`,
      );
      this.connected = false;
      this.client = null;
      this.tableEnsured = false;
      return false;
    }
  }

  async release(workerName: string, _fencingToken: number): Promise<void> {
    if (!this.connected || !this.client) return;
    try {
      const lockKey = this.hashWorkerName(workerName);
      await this.client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
      this.logger.log(`[leader-election] released lock for worker="${workerName}"`);
    } catch (err) {
      this.logger.warn(
        `[leader-election] release failed for worker="${workerName}": ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // Ignore errors on shutdown
      }
      this.client = null;
      this.connected = false;
      this.tableEnsured = false;
    }
  }
}
