# ADR 0005: Deadline jobs for intent expiry

- **Status**: Accepted
- **Date**: 2026-09-29
- **Technical Story**: #437 — replace the polling sweeper with deadline-scheduled jobs

## Context

`IntentsSweeperService` scanned every open and accepted intent every 30 seconds. Expiry latency was bounded by that interval, and the scan grew with intent volume.

The job queue from ADR 0002 is already in the process. It has delayed enqueue and idempotency keys. It does not have a cancel or replace API.

## Decision

Arm `expire-intent` when an intent is created and `fill-window-expired` when it is accepted or its fill deadline is extended. The delay is the time remaining until the stored deadline. The idempotency key is `job:intentId:deadline`.

A moved deadline enqueues a new job. The previous job still runs. The handler loads the intent and returns without writing when the state is terminal or the stored deadline is not the one in the payload.

The leader-elected sweep stays, at `SAFETY_SWEEP_INTERVAL_MS` (default 5 minutes), for jobs lost to a crash or a missed timer. Each intent it expires or slashes increments `vortex_sweeper_safety_caught_total`. That counter should stay near zero. `triggerManualSweep` is unchanged.

## Consequences

- Expiry no longer waits for the scan interval. A job fires at the deadline.
- Stale jobs are ignored rather than cancelled.
- Operators tune the safety net with `SAFETY_SWEEP_INTERVAL_MS`. The queue driver remains `JOBS_DRIVER` (`memory` or `bullmq`); this change does not add a second queue.
