# Runbook: Migrating intents from in-memory to Postgres

Issue #404. Covers moving a deployment's intent store through
`INTENTS_STORE=memory → dual → postgres`, how to tell each phase is healthy,
and how to roll back.

## Background

| Mode | Writes | Reads | Survives restart | Multi-replica safe |
|---|---|---|---|---|
| `memory` | in-process `Map` | `Map` | No | No — each replica has its own `Map` |
| `dual` | `Map`, then mirrored to Postgres | `Map` | Yes (memory is re-hydrated from Postgres at boot) | No — reads are still per-replica |
| `postgres` | Postgres | Postgres | Yes | Yes |

Guarantees that hold in every mode:

- **Atomic transitions.** `acceptIfOpen`, `fillIfAccepted`, `cancelIfOpen`,
  `expireIfOpen` and `slashIfAccepted` are each one conditional statement
  (`UPDATE … WHERE state = … RETURNING *` in Postgres) — no read-then-write.
- **Optimistic concurrency** (issue #405). Every write bumps `version`; writers
  that pass an expected version get a `VersionConflict` instead of overwriting
  a newer row. HTTP clients see this as `ETag` / `If-Match`.
- **Cross-replica idempotency.** `POST /intents` with an `idempotencyKey`
  inserts with `ON CONFLICT (idempotency_key) DO NOTHING`, so two replicas
  racing the same key produce one intent. Keys are replayable for 24 h.

`INTENTS_PERSISTENCE` is a deprecated alias: `prisma` means `postgres`. It is
only consulted when `INTENTS_STORE` is unset.

## Prerequisites

1. `DATABASE_URL` points at the target Postgres.
2. Migrations are applied: `npm run db:migrate:prod`. This PR adds
   `20260929000000_intent_version_idempotency` (`version`, `idempotency_key`,
   `slashed_at`, `slash_reason`, and the previously missing `fee_amount`).
3. Prometheus is scraping `GET /metrics`.

## Phase 1 — `dual`

1. Deploy with `INTENTS_STORE=dual`. Run a **single replica**: reads still come
   from memory, so multiple replicas would each serve their own view.
2. On boot, look for:
   ```
   [intents-store] dual-write backfill complete: loadedFromPostgres=N pushedToPostgres=M
   ```
   Backfill loads Postgres rows into memory (so restarts no longer lose
   intents) and pushes any memory-only rows to Postgres.
3. Soak until both of these hold for at least 24 h of normal traffic:
   - `sum(vortex_intents_store_mismatches) == 0` — the verifier runs every
     `INTENTS_VERIFY_INTERVAL_MS` (default 60 s) and sets this gauge per
     `kind` (`missing_in_postgres`, `missing_in_memory`, `field_mismatch`).
   - `increase(vortex_intents_dual_write_failures_total[24h]) == 0`.

### Investigating mismatches

The verifier logs up to five samples per run:

```
[intents-store] 2 mismatch(es) between memory and Postgres {"missing_in_postgres":1,...} samples=[{"intentId":"…","kind":"field_mismatch","fields":["state","version"]}]
```

- `missing_in_postgres` or `field_mismatch` alongside
  `vortex_intents_dual_write_failures_total` increments means mirror writes
  are failing. Check database connectivity and the `[dual-write]` error logs.
- `missing_in_memory` means a row reached Postgres that memory never held,
  for example because another replica was writing. Confirm only one replica
  is running.
- Mirror writes use a version-guarded upsert, so a mismatch never means
  Postgres was *rolled back* to an older version. The newer copy wins.

## Phase 2 — `postgres`

1. Set `INTENTS_STORE=postgres` and redeploy. Postgres is now the only store.
2. Horizontal scaling is now safe.
3. Watch `vortex_http_request_duration_seconds{route="/api/v1/intents",method="POST"}`.
   The budget is p95 < 50 ms. `test/load/intents-create-latency.test.ts`
   enforces it in CI against a Postgres service container.

## Rollback

| From → to | Procedure | Data impact |
|---|---|---|
| `dual` → `memory` | Set `INTENTS_STORE=memory`, redeploy | Memory starts from seed data; Postgres keeps everything written during `dual` |
| `postgres` → `dual` | Set `INTENTS_STORE=dual`, redeploy (single replica) | None — boot backfill loads every row into memory |
| `postgres` → `memory` | Not recommended. Go via `dual` | Everything in Postgres becomes invisible to the app |

### Schema rollback

The migration only adds nullable or defaulted columns, so the previous release
runs fine against the new schema without rolling it back. If the columns must
go, apply `prisma/migrations/20260929000000_intent_version_idempotency/down.sql`
as a change-managed operation (see `prisma/migrations/README.md`).
`fee_amount` is left in place because `schema.prisma` has always declared it.

## Admin job endpoints

All routes below live on `JobsController` under `/admin/jobs` and use the same
admin auth guards as the existing dead-letter listing route.

| Method & path | Purpose |
|---|---|
| `GET /admin/jobs/queues/:queue/dead-letters` | List dead-lettered jobs (read-only) |
| `POST /admin/jobs/queues/:queue/dead-letters/:jobId/retry` | Re-enqueue a single dead-lettered job on its source queue and remove it from the DLQ. The retry resets the attempt counter, so the job gets its full `JobDefinition.attempts` budget again. Returns 404 if `jobId` is not in the DLQ. |
| `GET /admin/jobs/queues/:queue/jobs/:jobId` | Look up a job's status (`pending` / `active` / `completed` / `failed`) plus its `result` or `error`. Results are retained for the same window as BullMQ's completed-job retention; older or unknown ids return a clear "not found" status. |

### Repeating schedules

| Method & path | Purpose |
|---|---|
| `GET /admin/jobs/queues/:queue/schedules` | List registered repeating schedules as `{ name, everyMs }[]` |
| `DELETE /admin/jobs/queues/:queue/schedules/:name` | Cancel a repeating schedule. Returns 404 if no schedule with that name exists. Jobs already enqueued from a previous tick are unaffected. |

## Restoring an archived partition

Restores no longer require shell access to a production host. Enqueue a restore
as a tracked background job:

```
POST /admin/archival/restore
{ "date": "2026-09-01", "schema": "restore_20260901", "dryRun": false }
```

The endpoint returns a `jobId`. Poll progress with the job-status endpoint:

```
GET /admin/jobs/queues/<restore-queue>/jobs/<jobId>
```

The job fetches the date's manifest from S3, downloads the partition, verifies
its checksum, and imports it into the staging schema. A missing manifest fails
the job with a clear error rather than hanging. The import uses
`ON CONFLICT … DO NOTHING`, so concurrent restores of the same date are safe.

`scripts/restore-archive.ts` remains available as a break-glass fallback for
situations where the API or job queue is unavailable, but it is no longer the
only path.
