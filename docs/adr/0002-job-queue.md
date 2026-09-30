# ADR 0002: Durable Job Queue — BullMQ on Redis

- **Status**: Accepted
- **Date**: 2026-09-28
- **Technical Story**: #494 — job queue infrastructure for background processing

## Context

Webhooks, deadline scheduling, archival, reports and backfills need reliable
background execution. Today each is an ad-hoc `setInterval` loop inside the
API process: no retries, no visibility, every replica runs every loop, and a
deploy kills whatever is mid-flight.

Requirements: typed jobs, per-queue concurrency, exponential retries, a
dead-letter queue (DLQ), idempotency keys, rate limiting, per-queue metrics,
an admin UI behind RBAC, a worker/producer role split and graceful shutdown.

## Options

| | **BullMQ (Redis)** | **pg-boss (Postgres)** |
|---|---|---|
| Infra | Adds Redis (already planned for `WS_BACKPLANE=redis`; also used by flag pub/sub, #495) | None — reuses Postgres |
| Throughput / latency | High; push-based workers, ms latency | Polling (`SKIP LOCKED`); adds load to the primary DB |
| Retries + backoff | Built in (`attempts`, exponential `backoff`) | Built in (`retryLimit`, `retryBackoff`) |
| DLQ | Not native — copy to `<queue>-dlq` on final failure | Native `deadLetter` |
| Idempotency | `jobId` dedupe | `singletonKey` |
| Rate limiting | Native, global across workers (`limiter`) | Not native (throttling per key only) |
| Repeatable jobs | `upsertJobScheduler` (idempotent across replicas) | `schedule` (cron) |
| Admin UI | Bull Board (mature, mountable in Express) | No maintained equivalent |
| Transactional enqueue with app writes | No | Yes |
| Graceful shutdown | `worker.close()` waits; stalled jobs are re-queued | `stop({ graceful })` |

## Decision

**BullMQ on Redis**, behind a small driver interface (`src/jobs/`):

- Native global rate limiting and Bull Board cover two acceptance criteria that
  pg-boss would need custom code for.
- Keeps queue polling load off the Postgres primary, which already carries the
  intent hot path.
- Redis is already in the architecture for the WS backplane and flag
  propagation, so the incremental ops cost is low.

The DLQ gap is closed in the driver: on the last failed attempt the job is
copied to `<queue>-dlq` (visible in Bull Board and `GET /admin/jobs/...`).

The loss of transactional enqueue is accepted: current producers are timers
and admin actions, not DB writes. If a future producer needs outbox semantics,
add an outbox table rather than switching queues.

A `memory` driver with the same semantics (retries, DLQ, idempotency,
concurrency, rate limit, shutdown) is the default for dev/test so the suite
does not need Redis. It is single-process and non-durable.

## Consequences

- `JOBS_DRIVER=bullmq` + `REDIS_URL` are required for multi-instance deploys.
- `PROCESS_ROLE` (`api` | `worker` | `all`) decides where workers run;
  producers work in every role.
- On SIGTERM workers get `JOBS_SHUTDOWN_TIMEOUT_MS` to finish; unfinished jobs
  are returned to the queue (BullMQ stalled-job recovery).
- Metrics: `vortex_jobs_queue_depth{queue,state}`, `vortex_jobs_duration_seconds`,
  `vortex_jobs_failures_total`, `vortex_jobs_dead_lettered_total`.
- Admin: Bull Board at `/admin/queues` (BullMQ driver) and
  `GET /admin/jobs/queues`, both behind `ADMIN_API_KEYS` (admin role).
- Reference migration: the intents store-size / retention loop is now the
  `maintenance/intents.store-size` repeatable job. Other loops migrate
  separately.
