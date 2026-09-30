# API Rate Limits, Resource Limits, and Abuse Prevention

This document details the rate limiting policies, resource-exhaustion hardening
(issue #476), abuse prevention mechanisms, error response formats, and client
retry guidelines for API consumers of `vortex-backend` (including
`vortex-frontend`, solver bots, and third-party integrations).

---

## Table of Contents

1. [Policy Overview](#policy-overview)
2. [HTTP Rate Limit Tiers](#http-rate-limit-tiers)
3. [Resource-Exhaustion Limits (issue #476)](#resource-exhaustion-limits-issue-476)
   - [Body size cap](#body-size-cap)
   - [JSON depth cap](#json-depth-cap)
   - [Batch lookup cap](#batch-lookup-cap)
   - [Pagination limit cap](#pagination-limit-cap)
   - [WebSocket chain-filter cap](#websocket-chain-filter-cap)
   - [WebSocket subscription-count cap](#websocket-subscription-count-cap)
   - [DB statement_timeout per route class](#db-statementtimeout-per-route-class)
4. [Error Response Formats](#error-response-formats)
5. [ReDoS Audit Status](#redos-audit-status)
6. [Client Integration Best Practices](#client-integration--best-practices)
7. [State-mutating endpoint signature audit](#state-mutating-endpoint-signature-audit)

---

## Policy Overview

To guarantee backend stability, protect system resources against Denial-of-Service
(DoS) attacks, and enforce fair usage, `vortex-backend` implements a multi-tiered
strategy:

1. **Global IP-Level Rate Limit** — protects all HTTP endpoints from general request flooding per IP.
2. **Per-User Intent Creation Limit** — protects the intent creation pipeline against spam per Stellar wallet.
3. **Resource-Exhaustion Limits** — cap array sizes, JSON depth, pagination values, WebSocket filter complexity, and DB query time so a single cheap request cannot force disproportionate server work.

---

## HTTP Rate Limit Tiers

| Tier / Guard | Target Endpoint(s) | Tracker Key | Window | Max Requests | Exceeded Action |
|---|---|---|---|---|---|
| **Global IP Throttle** | All HTTP (`/api/v1/*`, `/health`, `/docs`) | Remote IP | 60 s | 100 | `HTTP 429` |
| **Per-User Intent Guard** | `POST /api/v1/intents` | `dto.user` (Stellar address) | 60 s | 10 | `HTTP 429` |

> If the `user` field is absent the per-user guard falls back to tracking by remote IP.

---

## Resource-Exhaustion Limits (issue #476)

All limits below are **enforced at the application layer** before any DTO
validation or DB access.  They apply uniformly regardless of authentication
status, because the attack surface is the resource cost per request — not the
intent of the caller.

Limits are defined in `src/config/limits.config.ts` and can be overridden via
environment variables documented in `.env.example`.  The table below shows the
compile-time default and the env-override name.

### Body size cap

| Env var | Default | Enforced by |
|---|---|---|
| _(hard-coded via express `json()` middleware)_ | **10 KB** | `app.use(json({ limit: "10kb" }))` in `main.ts` |

Payloads larger than 10 KB are rejected before any parsing takes place.

- **Exceeded response:** `HTTP 413 Payload Too Large`
- **SDK note:** All real DTOs are flat structures of a few hundred bytes. 10 KB
  gives a 20–50× margin for future field additions while keeping amplification
  attacks impractical.

### JSON depth cap

| Env var | Default | Enforced by |
|---|---|---|
| `JSON_MAX_DEPTH` | **10** | Express middleware in `main.ts` (runs after body parse, before routing) |

JSON objects whose nesting exceeds `JSON_MAX_DEPTH` are rejected. This guards
against stack-exhaustion attacks that craft thousands of nested levels to exhaust
the call stack inside the JSON parser or class-validator's recursive traversal.

- **Exceeded response:** `HTTP 400 Bad Request` with
  `{ message: "JSON nesting depth exceeds the maximum allowed depth of 10" }`
- **SDK note:** All current DTOs are at most 2 levels deep. A cap of 10 gives
  a 5× margin.

### Batch lookup cap

| Env var | Default | Enforced by |
|---|---|---|
| _(static `@ArrayMaxSize` decorator)_ | **100 IDs** | `BatchLookupDto` in `src/intents/dto/batch-lookup.dto.ts` |

`POST /api/v1/intents/batch` accepts at most 100 intent IDs per request. Each ID
fans out to one DB read, so 100 is a deliberate budget ceiling (≈100 ms of DB
work at ~1 ms per indexed lookup).

- **Exceeded response:** `HTTP 400 Bad Request`
- **SDK note:** Solver bots reconciling thousands of intent IDs should page calls
  in batches of ≤100.

### Pagination limit cap

| Env var | Default | Enforced by |
|---|---|---|
| _(static `@Max` decorator)_ | **100 rows** | `ListIntentsDto` in `src/intents/dto/list-intents.dto.ts` |

`GET /api/v1/intents` and related list endpoints cap the `limit` query parameter
at 100. Requesting 10 000 rows would transfer tens of KB of JSON per call.

- **Exceeded response:** `HTTP 400 Bad Request`
- **SDK note:** Use cursor-based pagination (`cursor`) or offset pagination with
  `limit=100` for large datasets.

### WebSocket chain-filter cap

| Env var | Default | Enforced by |
|---|---|---|
| `WS_MAX_FILTER_CHAINS` | **20** | `IntentsGateway.handleSubscribe()` in `src/intents/intents.gateway.ts` |

A `{ type: "subscribe", chains: [...] }` message may include at most
`WS_MAX_FILTER_CHAINS` chain values. There are currently 7 supported chains;
a cap of 20 is 2.8× that — generous for multi-chain bots while blocking
clients that send thousands of values to force linear scan work.

- **Exceeded response:** WS frame `{ type: "subscribe_rejected", reason: "..." }`
  — the connection is **not** closed.
- **SDK note:** Solver bots typically subscribe to 1–3 chains. A cap of 20 is
  well above any realistic use case.

### WebSocket subscription-count cap

| Env var | Default | Enforced by |
|---|---|---|
| `WS_MAX_SUBSCRIPTIONS` | **10** | `IntentsGateway.handleSubscribe()` |

A single WS connection may send at most `WS_MAX_SUBSCRIPTIONS` successful
subscribe messages. Re-subscribing to update a chain filter counts as one
message; the counter is per-connection and resets on reconnect.

- **Exceeded response:** WS frame `{ type: "subscribe_rejected", reason: "..." }`
  — the connection is **not** closed.
- **SDK note:** Clients that need to update their chain filter simply send a new
  subscribe message (replacing the previous filter). Up to 10 subscribe messages
  per connection lifetime is more than enough for any normal usage pattern.

### DB statement_timeout per route class

| Env var | Default | Used by |
|---|---|---|
| `DB_QUERY_TIMEOUT_MS` | **5 000 ms** | Standard indexed lookups (intent by ID, user, state) |
| `DB_BATCH_QUERY_TIMEOUT_MS` | **10 000 ms** | Batch-lookup endpoints (`POST /intents/batch`) |
| `DB_STATS_QUERY_TIMEOUT_MS` | **15 000 ms** | Aggregate / leaderboard queries (`GET /solvers`, `/stats`) |

`PrismaService` exposes opt-in helpers (`withDefaultTimeout`, `withBatchTimeout`,
`withStatsTimeout`) that wrap a query in a `$transaction` and issue
`SET LOCAL statement_timeout = <ms>` before execution. This guards at the
Postgres level so even queries that bypass application middleware are bounded.

- **Exceeded response:** Postgres raises `57014 query_canceled`; the service
  returns `HTTP 500` (or a chain-specific error for the affected route).
- **SDK note:** These timeouts are generous relative to typical indexed-read
  latency. They fire only on pathological inputs (missing indexes, huge offsets,
  table scans) — not on normal traffic.

---

## Error Response Formats

### HTTP 413 — Payload Too Large (body size cap)

```json
{}
```
_(Express emits no body for 413 by default.)_

### HTTP 400 — Bad Request (depth/batch/pagination cap)

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "JSON nesting depth exceeds the maximum allowed depth of 10"
}
```

For DTO validation failures:
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["intentIds must contain no more than 100 elements"]
}
```

### WS subscribe_rejected

```json
{
  "type": "subscribe_rejected",
  "reason": "chains array may contain at most 20 values"
}
```

The connection remains open. Clients should wait briefly before retrying a
subscribe with a smaller payload.

### HTTP 429 — Too Many Requests (IP/per-user throttle)

```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests"
}
```

**Response headers:**

| Header | Description |
|---|---|
| `Retry-After` | Seconds until the rate-limit window resets |
| `X-RateLimit-Limit` | Total requests allowed in the window |
| `X-RateLimit-Remaining` | Remaining requests in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the counter resets |

---

## ReDoS Audit Status

**All validators pass.** The audit (`src/common/validators/redos-audit.spec.ts`)
covers every regex used in DTOs and validators:

| Pattern | File | Verdict |
|---|---|---|
| `/^S[A-Z2-7]{55}$/` | `src/config/env.validation.ts` | ✅ Safe — anchored, fixed-length `{55}` |
| `/^G[A-Z2-7]{55}$/` | `src/common/validators/is-valid-address.validator.ts` | ✅ Safe — anchored, fixed-length `{55}` |
| `/^0x[a-fA-F0-9]{40}$/` | `src/common/validators/is-valid-address.validator.ts` | ✅ Safe — anchored, fixed-length `{40}` |
| `/^\d+$/` | DTOs + `src/common/amount.ts` | ✅ Safe — anchored, simple character class |
| `/^[A-Z0-9]{56}$/` | `src/intents/dto/create-intent.dto.ts` | ✅ Safe — anchored, fixed-length `{56}` |
| `/^\s{2}([A-Z][A-Z0-9_]*):\s/gm` | `scripts/check-env-drift.ts` | ✅ Safe — no nested quantifiers |
| `/^([A-Z][A-Z0-9_]*)=/gm` | `scripts/check-env-drift.ts` | ✅ Safe — anchored per line |
| `/process\.env\.([A-Z][A-Z0-9_]*)/g` | `scripts/check-env-drift.ts` | ✅ Safe — no alternation |

None of these patterns contain nested quantifiers (`(a+)+`, `(a|aa)+`) or
alternating groups over the same character space — the two structures that
produce exponential backtracking in most regex engines.

---

## Client Integration & Best Practices

### Frontends (`vortex-frontend`)

- **Intent creation throttling:** Disable or grey-out the "Create Intent" button
  for 60 s after a user submits 10 intents.
- **Handling 429:** Read the `Retry-After` header and show a friendly message.
- **Handling 413:** This indicates a programming error in the client (payload too
  large); surface it as an internal error rather than a user-facing message.

### Solver operators and automated bots

- **Prefer WS over polling:** Subscribe to `ws://<host>/ws` with a chain filter
  rather than polling `GET /api/v1/intents`. WS connections are not subject to
  HTTP rate-limit counters.
- **Batch lookup vs. individual fetches:** Use `POST /api/v1/intents/batch` (up
  to 100 IDs per call) to reconcile large sets of intent IDs in a single round
  trip.
- **Exponential back-off with jitter:**
  ```
  delay = min(2^attempt × 1000 + jitter, 30000)  ms
  ```

### SDK-friendliness note

Limits are intentionally generous relative to typical single-user UI flows:

| Limit | Typical UI usage | Typical bot usage | Cap |
|---|---|---|---|
| Batch IDs | 1–3 | 10–50 | 100 |
| Page size | 10–20 | 50–100 | 100 |
| WS chain filter | 1 | 1–7 | 20 |
| WS subscriptions | 1 | 1–3 | 10 |

If a legitimate use case requires higher limits, contact the network operator
or configure the env vars on a self-hosted instance.

---

## State-mutating endpoint signature audit

This backend is intentionally stateless and relies on Ed25519 signatures over
a canonical message for every mutating action, so a wildcard
`Access-Control-Allow-Origin` does not create a CSRF issue.

| Route | Action | Canonical message | Proof required |
|---|---|---|---|
| `POST /api/v1/intents` | Create with high slippage | `acknowledge-high-slippage:<user>:<srcAmount>:<minDstAmount>` | Required only when `acknowledgeHighSlippage` is true; signed by the intent `user` |
| `POST /api/v1/intents/:id/accept` | Accept | `accept:<intentId>:<solver>` | Valid solver signature |
| `POST /api/v1/intents/:id/fill` | Fill | `fill:<intentId>:<solver>` | Valid solver signature |
| `POST /api/v1/intents/:id/cancel` | Cancel | `cancel:<intentId>` | Valid user signature |
| `POST /api/v1/solvers` | Register | `register:<solver>` | Valid proof signature |
| `POST /api/v1/solvers/:address/deactivate` | Deactivate | `deactivate:<solver>` | Valid solver signature |
| `POST /api/v1/solvers/:address/reactivate` | Reactivate | `reactivate:<solver>` | Valid solver signature |
| `POST /api/v1/solvers/:address/deregister` | Deregister | `deregister:<solver>` | Valid solver signature |

---

## Bypassing & custom limits

For high-throughput institutional solvers or internal services requiring custom
rate limits, contact the network operator or configure environment variables in
dedicated self-hosted instances.  All resource-exhaustion limits can be raised
via the env vars listed in the table above — see `.env.example` for the full
list and defaults.
