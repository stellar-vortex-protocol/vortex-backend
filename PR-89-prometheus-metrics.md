# PR: Add Prometheus Metrics Endpoint

## Summary

Adds a `/metrics` endpoint exposing Prometheus-compatible metrics using `prom-client`. This provides operational visibility beyond log lines, covering HTTP request metrics, intent state transitions, and WebSocket connection tracking.

## Changes

### New Files

- **`src/metrics/metrics.module.ts`** — Global module that registers `MetricsService`, `MetricsController`, and `MetricsInterceptor` (via `APP_INTERCEPTOR`).
- **`src/metrics/metrics.controller.ts`** — Exposes `GET /metrics` returning Prometheus text format.
- **`src/metrics/metrics.service.ts`** — Defines and manages all metric instruments:
  - `vortex_http_request_duration_seconds` — Histogram with buckets [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  - `vortex_http_requests_total` — Counter by method, route, status_code
  - `vortex_http_request_errors_total` — Counter for 5xx responses
  - `vortex_intent_state_transitions_total` — Counter by from_state, to_state
  - `vortex_ws_connections_active` — Gauge for active WebSocket connections
  - Default process metrics (CPU, memory, etc.) via `client.collectDefaultMetrics`
- **`src/metrics/metrics.interceptor.ts`** — Global HTTP interceptor that records duration, count, and errors for every request.

### Modified Files

- **`src/app.module.ts`** — Imports `MetricsModule`.
- **`src/intents/intents.service.ts`** — Injects `MetricsService` and records `incIntentStateTransition` on every state change in `update()`.
- **`src/intents/intents.gateway.ts`** — Tracks active WS connections via `MetricsService.incWsConnection`/`decWsConnection`.
- **`src/intents/intents.service.spec.ts`** — Updated to provide mock `MetricsService`.
- **`package.json`** — Added `prom-client` dependency.
- **`test/metrics.e2e-spec.ts`** — New e2e test verifying `/metrics` output contains all expected metric names and default process metrics.

## Implementation Details

### Metrics Design

All metrics use the `vortex_` prefix to avoid collisions. The registry is isolated to the `MetricsService` instance, ensuring clean separation. Default Node.js process metrics are collected with the same prefix.

### State Transition Tracking

`IntentsService.update()` now checks if the patch contains a `state` field and calls `metricsService.incIntentStateTransition(from, to)` when a transition occurs.

### WebSocket Tracking

`IntentsGateway` increments the WS gauge on `handleConnection` and decrements on `handleDisconnect` and `error`.

## Testing

All existing and new tests pass:

```
npm run lint       ✓ (1 warning, pre-existing)
npm run typecheck  ✓
npm test           ✓ 18 passed
npm run test:e2e   ✓ 25 passed (including new metrics e2e test)
```

### New Test

`test/metrics.e2e-spec.ts` verifies:
- `GET /metrics` returns 200 with `text/plain` content type
- Response contains `vortex_http_requests_total`, `vortex_http_request_duration_seconds`, `vortex_http_request_errors_total`, `vortex_intent_state_transitions_total`, `vortex_ws_connections_active`
- Response contains default process metrics (`vortex_process_cpu_seconds`)

Closes #89
