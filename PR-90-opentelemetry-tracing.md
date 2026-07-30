# PR: Add OpenTelemetry Tracing Instrumentation

## Summary

Adds distributed tracing via OpenTelemetry to enable end-to-end visibility into request latency across HTTP handlers, NestJS pipes/controllers, and WebSocket connections. Essential for debugging performance issues once on-chain Soroban RPC calls are introduced.

## Changes

### New Files

- **`src/tracing.ts`** — Initializes the OpenTelemetry `NodeSDK` with:
  - `@opentelemetry/instrumentation-http` — Auto-instruments HTTP server and client calls
  - `@opentelemetry/instrumentation-express` — Captures Express middleware and route handlers
  - `@opentelemetry/instrumentation-nestjs-core` — Instruments NestJS controllers, providers, and pipes
  - Exporter selection:
    - **Development**: `ConsoleSpanExporter` — prints spans to stdout for easy debugging
    - **Production**: `OTLPTraceExporter` — sends spans to an OTLP-compatible backend (e.g., Jaeger, Grafana Tempo, Honeycomb)
  - Graceful shutdown on `SIGTERM` / `SIGINT`

### Modified Files

- **`src/main.ts`** — Imports `./tracing` as the very first module, ensuring all instrumentation is registered before NestJS bootstraps.
- **`src/intents/intents.gateway.ts`** — Instruments WebSocket lifecycle with manual spans:
  - `ws.connect` — Tracks connection setup, snapshot generation
  - `ws.disconnect` — Tracks disconnection
  - `ws.broadcast.<event_type>` — Tracks event broadcasting with subscriber count attribute
- **`package.json`** — Added OpenTelemetry dependencies:
  - `@opentelemetry/api`
  - `@opentelemetry/sdk-node`
  - `@opentelemetry/auto-instrumentations-node`
  - `@opentelemetry/exporter-trace-otlp-proto`

## Implementation Details

### Tracing Initialization Order

The `import "./tracing"` at the top of `main.ts` is critical — OpenTelemetry must patch modules (via require-in-the-middle) before they are loaded. By importing tracing first, we guarantee HTTP, Express, and NestJS are instrumented before `NestFactory.create()` runs.

### WebSocket Manual Spans

Standard WebSocket instrumentation does not auto-instrument the `ws` library in the same way as HTTP. Manual spans are created for three lifecycle events:

1. **Connection** (`ws.connect`): Starts on `handleConnection`, ends after snapshot is sent. Records an event on client error.
2. **Disconnection** (`ws.disconnect`): Marks the end of a connection lifecycle.
3. **Broadcast** (`ws.broadcast.{type}`): Each `broadcast()` call creates a span tagged with `event.type` and `subscribers.sent`.

### Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP HTTP endpoint for exporting spans |
| `NODE_ENV` | `development` | When not `production`, uses ConsoleSpanExporter |

## Testing

All existing tests pass with no regressions:

```
npm run lint       ✓
npm run typecheck  ✓
npm test           ✓ 18 passed
npm run test:e2e   ✓ 23 passed
```

No new tests added — tracing is a cross-cutting concern verified by existing e2e tests continuing to pass. In production, trace output would be verified via the configured OTLP backend.

## Usage

### Local Development

Spans are printed to the console automatically:

```bash
npm run start
# Console output includes:
# {
#   "traceId": "...",
#   "name": "POST /api/v1/intents",
#   "kind": 1,
#   ...
# }
```

### Production

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your OTLP collector URL and ensure `NODE_ENV=production`.

Closes #90
