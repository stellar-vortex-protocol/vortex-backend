# Structured logging

Issue #488. Every log record the backend writes is one JSON object with a fixed, versioned schema. Log
queries, dashboards and the log-based security alerts depend on the field names below, so treat them as
an API: adding a field is fine, renaming or removing one is a breaking change that bumps
`schemaVersion`.

The schema is defined in code in [`src/common/log-schema.ts`](../../src/common/log-schema.ts). This page
is the operator-facing copy; if the two ever disagree, the code wins and this page is a bug.

## Record schema (`schemaVersion: 1`)

| Field           | Type   | Always | Meaning |
|-----------------|--------|--------|---------|
| `timestamp`     | string | yes    | ISO-8601 UTC |
| `level`         | string | yes    | `error` `warn` `info` `http` `verbose` `debug` `silly` |
| `message`       | string | yes    | Constant summary. Never contains ids or amounts — those are fields |
| `service`       | string | yes    | `LOG_SERVICE_NAME` (default `vortex-backend`) |
| `schemaVersion` | number | yes    | `1` |
| `component`     | string | no     | Emitting class or module, e.g. `IntentsService`, `http` |
| `event`         | string | no     | Stable dotted event name, e.g. `security.signature_failure` |
| `requestId`     | string | no     | Inbound `x-request-id` (if safe) or a generated UUID; echoed in the response header |
| `traceId`       | string | no     | OTel trace id — from the active span, or the caller's `traceparent` |
| `spanId`        | string | no     | OTel span id |
| `intentId`      | string | no     | Intent the record is about |
| `solver`        | string | no     | Solver address the record is about |
| `chain`         | string | no     | Chain the record is about |
| `jobId`         | string | no     | Background job id |
| `durationMs`    | number | no     | Elapsed time of the logged operation |
| `err`           | object | no     | `{ name, message, stack? }` |

Any other field is allowed, but must be camelCase and JSON-serialisable. The logger enforces this rather
than trusting call sites:

- keys are camelCased (`tx_hash` → `txHash`);
- a field that collides with a reserved key (`timestamp`, `level`, `message`, `service`,
  `schemaVersion`) is renamed with a trailing underscore (`level_`) instead of overwriting it;
- `Error`s become `err` objects, `bigint`s become strings, cycles become `"[Circular]"`;
- these keys are redacted at any depth: `signingKey`, `secretKey`, `secret`, `privateKey`, `password`,
  `authorization`, `token`, `apiKey`, `signature`.

### Events

`event` is what alerts and saved queries key on — never the message text. The values are constants in
`LOG_EVENTS` (`src/common/log-schema.ts`):

| `event` | Emitted by | Extra fields |
|---------|-----------|--------------|
| `security.signature_failure` | `verifyStellarSignature`, EVM EIP-712 verifier | `scheme`, `signer`, `reason`, `messageKind` |
| `security.signer_policy_violation` | signer policy `evaluatePolicy` deny | `reason`, `wallet`, `budgetKey` |
| `security.admin_auth_failure` | `AdminGuard` / `adminAuthMiddleware` | `reason`, `requiredRole`, `admin` |
| `admin.action` | `AdminAuditService.record` | `action`, `target`, `actor` |
| `http.request` | `LoggingInterceptor` | `method`, `path`, `statusCode`, `durationMs` |
| `intent.transition` | `IntentsService.appendAuditEntry` | `intentId`, `toState`, `actor`, `reason` |
| `webhook.delivery` | webhook delivery worker | `subscriptionId`, `deliveryId`, `outcome`, `statusCode` |

## Writing logs

Use the structured API. The message is a constant; everything variable goes in the fields object:

```ts
import { createLogger } from "../common/logger";

const log = createLogger("IntentsService");

log.info("registered intent on-chain", { intentId, txHash });
log.error("on-chain registration failed", { intentId, err });
```

The fields type (`LogFields`) only accepts JSON-able values, so `log.info(\`intent ${id} failed\`)` still
compiles but is caught in review — interpolated messages cannot be queried.

You do not need to pass `requestId`, `traceId`, `intentId` or `solver` when they are already known to the
request: `requestContextMiddleware` (mounted first in `main.ts`) opens an `AsyncLocalStorage` context per
request, and every record written inside it carries those fields. Code that learns the intent later can
add it with `bindLogContext({ intentId })`; background work can open its own scope with
`runWithLogContext({ jobId }, fn)`.

Nest's `Logger` (`new Logger(Foo.name)`) still works and goes through the same pipeline via
`NestStructuredLogger`, so legacy call sites emit schema-conformant records with `component` set — their
messages are just not as queryable until they are migrated.

### Migrated modules

Core-path call sites use the structured API: `IntentsService`, `IntentsSweeperService`, `IntentsGateway`,
`IntentFeedService`, `SlashingPipelineService`, `EventIngestionService`, `OutboxRelayService`,
`AdminAuditService`, `AdminGuard`, the signature verifiers, the signer policy, `HttpExceptionFilter`,
`LoggingInterceptor`, and the new partial-fill, destination-preflight and webhook services. The rest are
migrated as they are touched.

## Output formats

`LOG_FORMAT=json` writes one record per line — this is what the collector parses. `LOG_FORMAT=pretty`
writes `timestamp [level] (component) message key=value …` for local reading. Unset, production uses
`json` and everything else `pretty`. The shipping transport (`LOG_SHIPPING_*`) always sends JSON.

## Pipeline

```
app stdout (LOG_FORMAT=json) ──► otel-collector filelog ──┐
app LOG_SHIPPING (winston HTTP) ─► otel-collector :8088 ───┼─► Loki (OTLP) ──► Loki ruler ──► Alertmanager
app OTLP traces ───────────────► otel-collector :4317 ──── └─► Tempo
```

Bring it up with `docker compose --profile observability up -d`. Config lives in
[`ops/otel-collector/config.yaml`](../../ops/otel-collector/config.yaml); Loki's ruler reads
[`ops/observability/loki-rules/`](../../ops/observability/loki-rules/).

Loki stores the JSON line as the log body and the parsed fields as structured metadata, so both of these
work in Grafana Explore:

```logql
{service_name="vortex-backend"} | json | intentId="0f7c…"
{service_name="vortex-backend"} | json | event="security.signature_failure" | line_format "{{.signer}} {{.reason}}"
```

## Log-based alerts

Defined in `ops/observability/loki-rules/fake/vortex-security.yml`; response steps in
[`docs/runbooks/security-log-alerts.md`](../runbooks/security-log-alerts.md).

| Alert | Fires when |
|-------|-----------|
| `VortexSignatureFailureSpike` | > 50 `security.signature_failure` in 5 m, sustained 5 m |
| `VortexSignatureFailuresSingleSigner` | > 20 failures for one `signer` in 10 m |
| `VortexSignerPolicyViolation` | any `security.signer_policy_violation` |
| `VortexAdminAuthFailures` | > 10 `security.admin_auth_failure` in 5 m |
| `VortexAdminActionAnomaly` | > 25 `admin.action` in 15 m |
| `VortexAdminActionFanOut` | one `actor` touching > 10 distinct targets in 15 m |

Vendor SIEM integration is out of scope. The collector defines an OpenSearch exporter that can be added
to the logs pipeline to dual-write.

## Overhead

The hot-path cost is bounded by design:

- a record below the active level returns after one `isLevelEnabled` check — no field normalisation,
  no context lookup;
- the context lookup is one `AsyncLocalStorage.getStore()` per record;
- the request scope is one `AsyncLocalStorage.run` per request.

At the default `info` level the only per-request record is the `http.request` line.
`scripts/bench-logger.ts` measures the per-record cost on the current machine
(`npx tsx scripts/bench-logger.ts`); at 1k rps with one record per request it should be well under the
5% CPU budget.
