# Leader Election — Runbook & Architecture Notes

Issue: #493 | Status: Implemented

---

## Overview

`vortex-backend` runs two singleton background workers that must execute on **exactly one replica** at a time:

| Worker | Service | Interval |
|--------|---------|----------|
| `sweeper` | `IntentsSweeperService` | 30 s |
| `event-ingestion` | `EventIngestionService` | 10 s poll / 60 s reconcile |

Without coordination, every replica starts these workers in `onModuleInit`, multiplying RPC calls and risking duplicate slashes and conflicting state mutations. Leader election ensures only one replica runs each worker at any point in time.

---

## Architecture

### Mechanism

Postgres session-held advisory locks (`pg_try_advisory_lock`). A **dedicated `pg.Client` connection** (not Prisma, not PgBouncer) holds the lock for the lifetime of the process. When the process dies the TCP connection drops, releasing the lock immediately — no TTL needed.

```
Replica A (leader)          Replica B (follower)
─────────────────           ─────────────────────
pg_try_advisory_lock → 1    pg_try_advisory_lock → null
startInterval()             (waits, retries every heartbeat)
...
[process crashes]
TCP connection drops
lock released automatically
                            pg_try_advisory_lock → 2
                            startInterval()
```

### Fencing tokens

Each acquisition atomically bumps a counter in `vortex_leader_election`. The token is passed to worker callbacks so stale-leader writes can be detected.

### Failover time

`failover ≤ 3 × LEADER_ELECTION_HEARTBEAT_MS` (default ≤ 15 s).

### PgBouncer warning

**Do NOT use PgBouncer in transaction-pooling mode** for the leader election connection. Advisory locks are session-scoped — they are released when the connection is returned to the pool, causing silent lock loss. Use either:
- A direct TCP connection to Postgres
- PgBouncer in **session mode**

---

## Configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `LEADER_ELECTION_ENABLED` | `false` | Set `true` on multi-replica deployments |
| `LEADER_ELECTION_HEARTBEAT_MS` | `5000` | Heartbeat interval. Lower = faster failover, more DB load |

When `LEADER_ELECTION_ENABLED=false` (the default), a no-op backend is used and every worker starts unconditionally — identical to pre-election behaviour. Safe for single-instance dev/test.

---

## Enabling on a new deployment

1. Set `LEADER_ELECTION_ENABLED=true` in your environment.
2. Ensure `DATABASE_URL` points to a live Postgres instance **not** behind PgBouncer in transaction mode.
3. Deploy all replicas. The first to start will acquire the lock; the others will poll until failover is needed.
4. Verify via metrics (see below).

---

## Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `vortex_leader_election_is_leader` | Gauge | `worker` | `1` when this replica is leader, `0` otherwise |
| `vortex_leader_election_changes_total` | Counter | `worker`, `transition` (`acquired`/`lost`) | Leadership change events |

Useful Prometheus queries:

```promql
# Is there exactly one leader per worker?
count by (worker) (vortex_leader_election_is_leader == 1)

# Leadership churn rate (should be near zero in steady state)
rate(vortex_leader_election_changes_total[5m])
```

---

## Incident: leader is stuck / no worker is running

Symptom: `vortex_leader_election_is_leader` is `0` across all replicas for a worker.

Cause: All replicas lost their DB connection before releasing the lock, and the lock entry remains in `vortex_leader_election` with no live holder.

Resolution:
1. Verify at least one replica can connect to Postgres.
2. If the lock is stale (no replica holds a live TCP connection), it will be released automatically when the old TCP session times out (OS TCP keepalive, typically 2 hours on Linux unless tuned).
3. To recover immediately: `DELETE FROM vortex_leader_election WHERE worker_name = 'sweeper';`
4. The next heartbeat cycle (≤ `LEADER_ELECTION_HEARTBEAT_MS`) will cause a replica to acquire the lock.

---

## Incident: split brain (multiple leaders)

This should be impossible with session-held advisory locks, but if observed:

1. Check that no replica is using PgBouncer in transaction mode.
2. Check `vortex_leader_election_changes_total` for abnormally high churn (GC pauses causing heartbeat misses).
3. Increase `LEADER_ELECTION_HEARTBEAT_MS` to give more slack before a heartbeat miss is treated as a loss.

---

## Database table

Created automatically on first use; no migration required.

```sql
CREATE TABLE IF NOT EXISTS vortex_leader_election (
  worker_name  TEXT PRIMARY KEY,
  fence        BIGINT NOT NULL DEFAULT 0,
  holder       TEXT,
  acquired_at  TIMESTAMPTZ
);
```

---

## Adding a new singleton worker

1. Inject `LeaderElectionService` into the worker service.
2. Add `@Singleton('worker-name')` decorator above `@Injectable()`.
3. In `onModuleInit`, call `registerWorker` with start/stop callbacks:

```typescript
@Singleton('my-worker')
@Injectable()
export class MyWorkerService implements OnModuleInit, OnModuleDestroy {
  private interval?: NodeJS.Timeout;

  constructor(private readonly election: LeaderElectionService) {}

  onModuleInit() {
    this.election.registerWorker('my-worker', (isLeader) => {
      if (isLeader) this.start();
      else this.stop();
    });
  }

  onModuleDestroy() { this.stop(); }

  private start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.work(), 30_000);
  }

  private stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
  }
}
```

4. No changes to `LeaderElectionModule` are needed — it runs a single heartbeat loop for all registered workers.

---

## References

- [How to do distributed locking — Martin Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Postgres Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- [Kubernetes Leases](https://kubernetes.io/docs/concepts/architecture/leases/) (optional future backend)
