# On-Call Runbook — Vortex Backend

> **Scope:** This document covers the two most common on-call scenarios for
> `vortex-backend`: (1) Soroban RPC dependency outages and (2) a stuck or
> slow intent sweeper.  
> Last updated: 2026-08-30

---

## Table of Contents

1. [Service overview](#service-overview)
2. [What "normal" looks like](#what-normal-looks-like)
3. [SLOs and burn-rate alerts](#slos-and-burn-rate-alerts)
4. [Scenario A — Soroban RPC downtime](#scenario-a--soroban-rpc-downtime)
5. [Scenario B — Stuck or slow sweeper](#scenario-b--stuck-or-slow-sweeper)
6. [Scenario C — Emergency kill-switch](#scenario-c--emergency-killswitch-issue-477)
7. [Scenario D — Guardian emergency action](#scenario-d--guardian-emergency-action)
8. [Scenario E — Synthetic canary failing](#scenario-e--synthetic-canary-failing)
9. [Health probes](#health-probes)
10. [Scenario F — WebSocket backplane and slow consumers](#scenario-f--websocket-backplane-and-slow-consumers)
11. [Key configuration](#key-configuration)
12. [Escalation path](#escalation-path)

---

## Service overview

`vortex-backend` is a NestJS HTTP + WebSocket service that:

- Accepts swap intents from users via `POST /api/v1/intents`
- Brokers them to solvers over a WebSocket feed (`WS /ws`)
- Reads chain state from a Soroban RPC node (`/api/v1/chain/*`)
- Expires stale open intents every 30 seconds via `IntentsSweeperService`

The HTTP/WS core is **fully in-memory** — a Soroban RPC outage degrades chain
read endpoints but does **not** take down the intent relay or WebSocket feed.

---

## What "normal" looks like

| Signal | Healthy value |
|---|---|
| `GET /health` | `200 { status: "ok" }` |
| `GET /api/v1/chain/health` | `200` with Soroban `status: "healthy"` |
| Sweeper log (every 30 s) | Debug line: `sweep complete: expired=N duration=Xms` |
| `vortex_sweeper_sweep_duration_ms` p99 | < 50 ms under normal load |
| `vortex_sweeper_expired_total` | Monotonically increasing; spikes expected near intent `deadline` clusters |
| WS subscriber count | Stable or slowly growing; sudden drops indicate client-side churn |
| Node.js heap | Steady-state < 200 MB; no sustained upward trend between GC cycles |

---

## SLOs and burn-rate alerts (issue #480)

Definitions: `ops/slo/slos.yaml` (OpenSLO). Generated rules:
`ops/prometheus/rules/vortex-slo.yml`, tested by `vortex-slo_test.yml`.

| SLO | Objective | Alert |
|---|---|---|
| Relay availability | 99.9% non-5xx / 30d | `VortexHighBurnRate` (page, 1h/5m) / `VortexSlowBurnRate` (ticket, 6h/30m) |
| Intent-create latency | p95 < 500ms / 7d | `VortexCreateLatencyHigh` (ticket) |
| WS delivery latency | p95 < 1s / 7d | `VortexWsDeliveryLatencyHigh` (ticket, p99 > 2s) |
| Event-ingestion lag | < 30s 99% / 7d | `VortexIngestionLagHigh` (page) |
| Tx confirmation latency | p95 < 60s / 7d | `vortex:confirm:p95_5m` recording rule, ticket on sustained breach |
| Intent lifecycle | ≥ 95% of opened intents reach a terminal state | `VortexIntentsNotTerminating` (ticket) |
| Intent settlement | ≥ 90% of accepted intents fill | `VortexSolverFillRateLow` (ticket) |
| On-chain cutover parity | 0 outcome mismatches | `VortexShadowDivergenceDetected` (page), see `onchain-cutover.md` |

SLIs: `vortex_http_requests_total`, `vortex_intent_create_duration_seconds`,
`vortex_ws_delivery_duration_seconds`, `vortex_event_ingestion_lag_seconds`,
`vortex_tx_confirmation_duration_seconds` (see `src/metrics/metrics.service.ts`).
Fast-burn alerts require a minimum throughput (`>100 events/h`) so low-traffic
periods do not page.

### Dashboards for each alert (issue #481)

Every alert above carries both a `runbook_url` and a `dashboard_url`
annotation, so the notification links straight to the graph that shows the
problem. The committed dashboards live in `ops/grafana/dashboards` and are
provisioned by the `observability` Compose profile
(`docker compose --profile observability up -d`, Grafana on
<http://localhost:3001>).

| Alert | Dashboard |
|---|---|
| `VortexHighBurnRate`, `VortexSlowBurnRate`, `VortexCreateLatencyHigh` | `vortex-api-red.json` |
| `VortexIngestionLagHigh`, `VortexShadowDivergenceDetected`, `VortexShadowMonitorStarved`, `VortexShadowMonitorUnconfigured` | `vortex-onchain-pipeline.json` |
| `VortexIntentsNotTerminating` | `vortex-intent-funnel.json` |
| `VortexSolverFillRateLow` | `vortex-solver-network.json` |
| `VortexWsDeliveryLatencyHigh` | `vortex-ws-feed.json` |

Run the local stack with `node ops/grafana/build.mjs` if the committed JSON is
stale; the dashboards are generated, not hand-edited. See
`ops/grafana/README.md`.

---

## Scenario A — Soroban RPC downtime

### Symptoms

- `GET /api/v1/chain/health` returns `502 Bad Gateway` or hangs.
- `GET /api/v1/chain/ledger` / `GET /api/v1/chain/network` return 5xx.
- Logs contain repeated errors from `SorobanRpc.Server`:
  ```
  Error: Network error: failed to fetch
  // or
  Error: Response code 503 (Service Unavailable)
  ```
- `GET /api/v1/chain/account/:key` returns 5xx.

### Impact

| Affected | Not affected |
|---|---|
| `/api/v1/chain/*` read endpoints | `/api/v1/intents` CRUD |
| On-chain account lookups | `WS /ws` intent feed |
| Future on-chain writes (roadmap) | Sweeper — runs entirely in-memory |

The intent relay continues operating. Users and solvers can still submit and
fill intents. Only chain-read features are degraded.

### Diagnosis steps

1. **Confirm it is the upstream RPC**, not the service itself:
   ```bash
   curl -s https://soroban-testnet.stellar.org/health
   # should return {"status":"healthy"}
   ```
   Check the [Stellar Status page](https://status.stellar.org) for ongoing
   incidents.

2. **Check `SOROBAN_RPC_URL` is correct** in the running environment:
   ```bash
   # In the container / pod
   echo $SOROBAN_RPC_URL
   ```
   The default is `https://soroban-testnet.stellar.org`.

3. **Check DNS** from inside the container:
   ```bash
   nslookup soroban-testnet.stellar.org
   ```

4. **Check logs** for the first occurrence of the error to determine onset:
   ```bash
   grep -i "soroban\|rpc\|stellar" /var/log/vortex-backend.log | tail -40
   ```

### Remediation

| Action | Command / step |
|---|---|
| Switch to a backup RPC endpoint | Set `SOROBAN_RPC_URL` and restart the service |
| Temporarily suppress 5xx alerts for chain endpoints | Add a monitoring exception for `/api/v1/chain/*` |
| Communicate to users | Post a degradation notice; intent relay is unaffected |

### Recovery confirmation

```bash
curl -s http://localhost:4000/api/v1/chain/health
# expect: {"status":"healthy",...}
```

---

## Scenario B — Stuck or slow sweeper

### Symptoms

- No `sweep complete` debug log for > 60 seconds (two missed intervals).
- Sweep duration metrics (`sweepDurationMs`) show p99 > 1 second.
- Open intents with `deadline` in the past are not transitioning to `expired`.
- WS clients are not receiving `intent_expired` events.
- CPU spike coincident with sweeper interval (every 30 s).

### What a healthy sweep looks like in logs

```
[IntentsSweeperService] sweep complete: expired=0 duration=2ms totalExpired=42
```

A sweep that has been delayed or killed will simply be absent.

### How the sweeper works

`IntentsSweeperService.sweep()` is triggered by a `setInterval` every
`SWEEP_INTERVAL_MS` (30 000 ms, hardcoded).  It:

1. Calls `IntentsService.getByState("open")` — iterates the in-memory store.
2. Compares each intent's `deadline` (Unix timestamp) against `Date.now()`.
3. Calls `IntentsService.update()` and `IntentsGateway.broadcast()` for each
   expired intent.
4. Records `vortex_sweeper_sweep_duration_ms` and increments
   `vortex_sweeper_expired_total` via `MetricsService.recordSweep()` (Prometheus,
   exposed on `GET /metrics`). The retired `MetricsRegistry` from
   `src/common/metrics.ts` has been removed (issue #259) — use the
   Prometheus metric names above for alerting and dashboards.

Because the store is in-memory and the loop is synchronous, the sweep should
complete in **single-digit milliseconds** for < 10 000 open intents.

### Possible causes and fixes

| Cause | Indicator | Fix |
|---|---|---|
| Node.js event loop blocked | Sweep log missing, but service still responding to HTTP | Profile with `clinic flame` or `node --prof`; identify the blocking call |
| `setInterval` not firing (module destroyed prematurely) | `onModuleDestroy` called without `onModuleInit` | Investigate graceful-shutdown lifecycle; restart the process |
| Runaway open-intent accumulation | `IntentsService.getByState("open")` returning tens of thousands of items | Investigate why intents are not being filled/cancelled; a per-user cap of **50 simultaneous open/accepted intents** (`MAX_OPEN_INTENTS_PER_USER` in `src/intents/intents.service.ts`) is enforced at creation time — if you see accumulation beyond this per-user limit investigate whether the cap enforcement path (HTTP 409 on `POST /api/v1/intents`) is reachable, or whether old seed/test data was inserted directly into the store |
| Broadcast fan-out stalling | `IntentsGateway.broadcast()` slow due to thousands of WS subscribers | Reduce subscriber count or move to async fan-out; see issue #84 load-test results |
| Clock skew | All intents appear non-expired despite past deadlines | Verify `Date.now()` on the server and compare against intent `deadline` values; fix NTP |

### Manual sweep trigger (emergency)

The service installs a **`SIGUSR2` handler** that runs exactly one
`IntentsSweeperService.sweep()` cycle on demand. This is the supported
break-glass mechanism — do **not** attach a Node.js REPL to the process.

**Why a signal and not an HTTP endpoint:** it requires shell access to the
host (so it is inherently operator-only and unreachable by any API client),
needs no separate secret to manage, and every invocation is logged loudly so
it shows up clearly in the incident timeline.

```bash
# 1. Find the backend PID
pgrep -f "node dist/main.js"

# 2. Trigger one sweep cycle
kill -USR2 <pid>
#   In Kubernetes:
#   kubectl exec <pod> -- kill -USR2 1
```

The trigger is synchronous and idempotent — sending `SIGUSR2` again simply
runs another cycle. Confirm it ran by grepping the logs:

```bash
grep "MANUAL SWEEP" /var/log/vortex-backend.log | tail -5
# [sweeper] MANUAL SWEEP TRIGGERED (source=SIGUSR2, invokedAt=...) — running one sweep cycle
# [sweeper] MANUAL SWEEP COMPLETE (source=SIGUSR2, invokedAt=...): expired=N slashed=M duration=Xms
```

If a manual sweep is needed repeatedly, the sweeper's own 30-second interval
is broken — escalate to the service owner rather than scripting the signal.

### Diagnosis steps

1. **Check the last sweep timestamp** in logs:
   ```bash
   grep "sweep complete" /var/log/vortex-backend.log | tail -5
   ```

2. **Check current open-intent count** via the API:
   ```bash
   curl -s http://localhost:4000/api/v1/intents/open | jq '.intents | length'
   ```
   A very large number (> 1 000) with many past-deadline entries confirms the
   sweeper is not running.

3. **Check metrics** (if a metrics endpoint is wired up):
   ```bash
   curl -s http://localhost:4000/metrics | grep sweeper
   # vortex_sweeper_sweep_duration_ms_count
   # vortex_sweeper_sweep_duration_ms_sum
   # vortex_sweeper_expired_total
   ```

4. **Inspect process health**:
   ```bash
   # CPU and memory
   top -p $(pgrep -f "node dist/main.js")

   # Open file descriptors (WS connections count as FDs)
   ls /proc/$(pgrep -f "node dist/main.js")/fd | wc -l
   ```

### Recovery confirmation

After a restart or fix, confirm:

```bash
# 1. Service is responding
curl -s http://localhost:4000/health

# 2. Sweep fires within 30 s — watch for the log line
journalctl -fu vortex-backend | grep "sweep complete"

# 3. Past-deadline intents are now expired
curl -s http://localhost:4000/api/v1/intents?state=open | jq '[.intents[] | select(.deadline < now)] | length'
# should be 0
```

---

## Scenario C - Emergency kill-switch (issue #477)

Use this whenever the safe move is to stop writing: a depegged token, a
compromised or misbehaving solver, a chain/RPC incident, or any anomaly where you
would rather freeze than keep settling.

The full procedure, API reference, and failure modes are in
**[killswitch.md](./killswitch.md)**. The short version:

```bash
KS=http://localhost:4000/api/v1/ops/killswitch

# 1. Inspect current state first.
curl -s "$KS" -H "x-operator-token: $TOKEN" | jq

# 2. Pause the narrowest scope that covers the problem. Start narrow.
curl -sX POST "$KS/pause" \
  -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"chain","chain":"stellar","reasonCode":"CHAIN_DEGRADED","reason":"RPC errors >20%"}'
```

Scopes are `global`, `chain`, `token`, and `operation`; operations are `create`,
`accept`, `fill`, `slash`, and `onchain`. Pausing `onchain` stops every write
that reaches the chain.

### Verifying it took effect

Blocked writes return **503** with `Retry-After` and a `reason` code. Check
every replica, not just the one you called:

```bash
for port in 4000 4001 4002; do
  curl -s localhost:$port/health | jq -c '{port:'"$port"', killswitch}'
done
```

A pause is an operational state, not an outage — `/health` keeps reporting
`status: "ok"`. Use the `killswitch` block, and the `propagation` field, to tell
"paused" apart from "healthy".

Watch the sweeper logs: while `fill` is paused it must log deadline extensions
rather than slashes.

```bash
docker logs vortex 2>&1 | grep -E "Kill-switch|sweeper.*paused"
```

### Resuming

Two **different** operators must approve, and the broadest scope goes first:

```bash
curl -sX POST "$KS/resume/$SWITCH_ID" -H "x-operator-token: $TOKEN" \
  -H "x-operator-id: $ME" -H 'content-type: application/json' -d '{}'
# -> {"resumed": false, "approvals": 1, "required": 2}
```

`resumed: false` means "recorded, not yet reopened" — that is expected after the
first approval.

### If the switch itself is the problem

If writes are being refused but no switch is listed, the replica has not loaded
its snapshot and is failing closed. `ready: false` in `/health` points at the
database. See "Failure modes" in [killswitch.md](./killswitch.md).

## Scenario D — Guardian emergency action

The backend ingests emergency actions from the on-chain guardian / security
council contract (`GUARDIAN_CONTRACT_ID`, issue #507) and applies them within
one poll (10 s) on every instance:

| Guardian event | Backend effect |
|---|---|
| `guardian_pause` / `guardian_unpause` | Acts as a global kill switch (reason `GUARDIAN_PAUSE`): every kill-switch-gated write returns **503**. Cancels still work. |
| `guardian_freeze` / `guardian_unfreeze` (target = flag key or `*`) | Runtime feature flag changes for that key return **409**. |
| `guardian_blacklist` / `guardian_unblacklist` (target = solver) | Solver cannot accept intents (**403**); operator reactivation returns **409**. |

### Check status

```bash
curl -s http://localhost:4000/api/v1/governance/guardian/status | jq
# { paused, guardianPaused, operatorSwitches: [...], guardianActions: [{ id, kind, target, txHash, ledger, activatedAt }], ... }
```

Every active action carries its `txHash` — confirm it on a block explorer
before acting.

### Rules while a guardian action is active

- Guardian state is **authoritative**. Operators cannot clear it: resuming
  operator kill switches (Scenario C), solver reactivation and flag edits on a
  frozen key do not lift guardian state.
- The guardian pause is evaluated independently of operator switches. A
  guardian unpause while an operator switch is active leaves writes paused
  (and vice versa) — **both must clear**.

### Manual override (break-glass)

Only for a confirmed false positive, with sign-off from the security council.
Requires a **superadmin** key and is refused unless the audit record is
written (`admin_audit_log`, action `guardian.override`):

```bash
curl -X POST -H "x-admin-key: $SUPERADMIN_KEY" -H 'content-type: application/json' \
  -d '{"reason":"false positive, council ack in #sec-incident"}' \
  http://localhost:4000/api/v1/governance/guardian/actions/<actionId>/override
```

The override lasts until the guardian emits a new action for the same target.

---

## Scenario E — Synthetic canary failing

Alerts `VortexCanaryConsecutiveFailures`, `VortexCanaryFundsLow`,
`VortexCanaryBudgetExceeded` come from the canary CronJob
(`tools/canary/`, issue #496).

1. Check `vortex_canary_step_duration_seconds{step=...}` for the last step
   that reported — the failing step is the one after it — and the CronJob pod
   logs (`[canary] FAILED ...` names the HTTP call and status).
2. `create`/`accept`/`fill` returning 503 → check Scenarios C and D (paused).
3. `fill` failing on-chain → canary funds or trustline issue; check
   `vortex_canary_balance_xlm`.
4. Funds low / budget exceeded → suspend the CronJob
   (`kubectl patch cronjob <name> -p '{"spec":{"suspend":true}}'`), top up the
   canary solver account, investigate fee spikes before resuming.

Canary intents are excluded from public stats and leaderboards via
`CANARY_ADDRESSES`; if they show up there, that variable is missing on the API.

---

## Health probes

Issue #492. All three probes read results cached by a background checker
(every `HEALTH_CHECK_INTERVAL_MS`), so they answer in < 50 ms whatever the
dependencies are doing.

| Endpoint | Meaning | Fails (503) when |
|---|---|---|
| `GET /health/live` | Process is responsive | Event-loop delay > `HEALTH_EVENT_LOOP_MAX_LAG_MS`. Dependency outages never fail it, so pods are not restarted during an outage. |
| `GET /health/ready` | Can serve its roles (`SERVICE_ROLES`) | An indicator critical to one of those roles is down for `HEALTH_READY_FAILURE_THRESHOLD` consecutive checks. It turns ready again after `HEALTH_READY_SUCCESS_THRESHOLD` passes (hysteresis). `status: "degraded"` = a non-critical dependency is down. |
| `GET /health/startup` | Migrations applied, caches warmed | Until every startup indicator has passed once. |
| `GET /health` | Legacy aggregate (unchanged, plus `backplane`) | Never |

Indicators (`indicators` in the `/health/ready` body, with `critical`, `error`, `details`):

| Indicator | Critical for | Notes |
|---|---|---|
| `database` | api, worker — only when a `*_PERSISTENCE=prisma` adapter is used | `SELECT 1` |
| `migrations` | startup | Every directory in `prisma/migrations` is applied in `_prisma_migrations` |
| `soroban_rpc_quorum` | worker | Majority of `SOROBAN_RPC_HEALTH_URLS` answer `getHealth` = healthy |
| `ws_backplane` | ws — when `WS_BACKPLANE=redis` | Replica can read the Redis stream |
| `killswitch_snapshot` | api, startup | Kill-switch snapshot loaded (writes fail closed without it) |

Metrics: `vortex_health_ready`, `vortex_health_indicator_up{indicator}`,
`vortex_health_check_duration_seconds{indicator}`.

Kubernetes probes (split deployments set `SERVICE_ROLES` per workload, e.g.
`api,ws` for HTTP pods and `worker` for workers):

```yaml
startupProbe:
  httpGet: { path: /health/startup, port: 4000 }
  periodSeconds: 5
  failureThreshold: 60      # up to 5 min for migrations + cache warm-up
livenessProbe:
  httpGet: { path: /health/live, port: 4000 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /health/ready, port: 4000 }
  periodSeconds: 5
  failureThreshold: 1       # hysteresis is applied server-side
```

---

## Scenario F — WebSocket backplane and slow consumers

**Backplane (issue #454).** With `WS_BACKPLANE=redis` every replica publishes
events into a Redis stream (`vortex:ws:events`) with a global sequence number
(`vortex:ws:seq`) and delivers from that stream, so clients on any replica
see the same events, in the same order, with the same `seq`, and replay works
against any replica. Publishing is queued in the background — request
handlers never wait for Redis.

- **Redis down:** `/health/ready` on WS-role pods goes 503 (`ws_backplane`
  down) and `vortex_ws_backplane_connected` drops to 0. Publishes queue
  (bounded) and are retried in order; on recovery each replica resumes the
  stream from the last event it delivered — no loss, duplicates or
  reordering. Watch `vortex_ws_backplane_dropped_total{reason="queue_full"}`
  for events dropped during a long outage.
- **Latency:** `vortex_ws_backplane_publish_duration_seconds`.

**Connection limits and slow consumers (issue #455).**

- Connections over `WS_MAX_CONNECTIONS` or `WS_MAX_CONNECTIONS_PER_IP` are
  closed with 1013 (`vortex_ws_connections_rejected_total{reason}`). Behind a
  load balancer set `WS_TRUST_PROXY_HOPS` to the number of proxies, or every
  client shares the proxy's IP.
- Clients over the inbound token bucket get `rate_limited` frames and are
  closed with 1008 after `WS_RATE_LIMIT_MAX_VIOLATIONS`
  (`vortex_ws_rate_limited_total{action}`). Frames over
  `WS_MAX_PAYLOAD_BYTES` close the socket with 1009.
- Slow consumers: once a socket's buffer passes `WS_OUTBOUND_BUFFER_BYTES`,
  messages queue (at most `WS_OUTBOUND_QUEUE_MAX`); beyond that the oldest are
  dropped (`vortex_ws_outbound_dropped_total`) or, with
  `WS_SLOW_CONSUMER_POLICY=disconnect`, the client is closed
  (`vortex_ws_slow_consumer_disconnects_total`). Clients recover dropped
  events with `replay` — the solver SDK does this automatically.
- Solvers can authenticate with a SEP-10 JWT (`?token=`, `Authorization:
  Bearer`, or `{ "type": "auth", "token" }`) when `AUTH_JWT_SECRET` is set,
  in addition to signed `auth` frames. Anonymous connections still receive
  the public feed.

---

## Key configuration

| Variable | Default | Effect |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Upstream Soroban JSON-RPC endpoint |
| `STELLAR_NETWORK` | `testnet` | Network passphrase selection |
| `PORT` | `4000` | HTTP + WS listen port |
| `NODE_ENV` | `development` | Log verbosity (set to `production` in prod) |
| `SWEEP_INTERVAL_MS` | `30000` (hardcoded) | How often the sweeper runs; change requires code deploy |
| `KILLSWITCH_OPERATOR_TOKEN` | empty (control plane disabled) | Secret for `/api/v1/ops/killswitch`; **required in production** |
| `KILLSWITCH_REDIS_URL` | `REDIS_URL` when `WS_BACKPLANE=redis` | Cross-replica pause propagation; empty = poll only |
| `KILLSWITCH_POLL_MS` | `2000` | DB change-probe interval backing up Redis; caps propagation delay |
| `KILLSWITCH_PERSISTENCE` | `memory` | `prisma` in production, or a pause is lost on restart |
| `GUARDIAN_CONTRACT_ID` | empty (disabled) | Guardian contract polled for emergency actions |
| `ADMIN_API_KEYS` | empty (admin APIs disabled) | `id:role:secret` entries for admin / superadmin endpoints |
| `PROCESS_ROLE` / `JOBS_DRIVER` | `all` / `memory` | Where job workers run; `bullmq` for multi-instance |
| `CANARY_ADDRESSES` | empty | Canary accounts excluded from public stats |

---

## Escalation path

1. **On-call engineer** — check this runbook and attempt the listed remediation steps.
2. **Service owner** — if the sweeper is structurally broken (not just slow) or if the Soroban outage persists > 30 minutes.
3. **Stellar / Horizon team** — if `soroban-testnet.stellar.org` is confirmed down; follow [Stellar Discord #dev-support](https://discord.gg/stellardev).

> For production incidents open a severity-1 ticket and page the service owner
> via the alerting system.

---

## Inspecting Stuck Transactions (#386)

Transactions in `pending_transactions` with `status = 'pending'` and `next_poll_at` in the past are being actively retried by `TxConfirmationService`. Normal retries use exponential backoff up to `max_track_until`.

### Find all stuck transactions

```sql
SELECT tx_hash, intent_id, attempts, fee_bump_count,
       to_timestamp(next_poll_at) AS next_poll_at_ts,
       to_timestamp(max_track_until) AS expires_at,
       created_at
FROM   pending_transactions
WHERE  status = 'pending'
  AND  next_poll_at < extract(epoch FROM now())
ORDER  BY next_poll_at ASC
LIMIT  50;
```

### Force-expire a stuck transaction

```sql
UPDATE pending_transactions
SET    status = 'expired', updated_at = now()
WHERE  tx_hash = '<hash>';
```

### Inspect dead-lettered events (#389)

```sql
SELECT ledger, event_index, contract_id, network, last_error, attempts, created_at
FROM   dead_letter_events
ORDER  BY created_at DESC
LIMIT  20;
```

### Key Prometheus metrics

| Metric | Alert threshold |
|--------|----------------|
| `vortex_tx_confirmation_outcomes_total{status="confirmed\|failed\|expired"}` | — (informational) |
| `vortex_tx_confirmation_latency_seconds` | p99 > 120 s |
| `vortex_tx_fee_bump_total{percentile}` | — (informational) |
| `vortex_tx_fee_bump_ceiling_hits_total` | > 0 (alert) |
| `vortex_channel_pool_utilisation` | > 0.9 sustained |
| `vortex_channel_bad_seq_resyncs_total` | spike > 10/min |
| `vortex_ingestion_cursor_lag_ledgers` | > 200 ledgers |
| `vortex_ingestion_dead_letter_total` | > 0 (alert) |
