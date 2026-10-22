# Emergency Kill-Switch Runbook (issue #477)

The kill-switch is the protocol's emergency stop. When something is wrong with
settlement — a depegged token, a compromised solver, a degraded chain — an
operator can stop writes at any scope within seconds, without a deploy.

**When in doubt, pause first and investigate second.** A pause is cheap and
reversible; a bad fill is not.

---

## How it works

A switch is addressed by one of four scopes. Evaluation walks broadest to
narrowest, and **any active match blocks the write**:

| Scope       | Gates                                  | Example                              |
| ----------- | -------------------------------------- | ------------------------------------ |
| `global`    | every write, every chain, every token  | protocol-wide incident               |
| `chain`     | every write on one chain              | Stellar RPC degrading                |
| `token`     | every write involving one token       | USDC depegged on Base                |
| `operation` | one operation, optionally one token   | stop slashing, keep quoting          |

Gated operations: `create`, `accept`, `fill`, `slash`, `onchain`.
`onchain` is an umbrella that also stops `fill` and `slash`.

### Fail-closed

- A write is refused if the replica cannot load its switch snapshot.
- A narrower switch that is *inactive* does **not** re-open a scope a broader
  active switch is holding closed. To resume safely, clear the broad switch
  first, then the narrow one.
- If Redis is unavailable, propagation falls back to a database poll; the
  control plane never depends on Redis being up.

### Blocked responses

Gated writes return **503** with a `Retry-After` header and a machine-readable
body:

```json
{
  "error": "Killswitch active",
  "reason": "TOKEN_DEPEGGED",
  "message": "USDC depegged on Base, fills halted",
  "scope": "token",
  "chain": "base",
  "token": "0xabc...",
  "operation": "fill",
  "activatedBy": "alice",
  "since": 1756300000000
}
```

Clients should treat 503 + `Retry-After` as retryable and must not treat it as a
permanent failure. This is deliberately distinct from 429 (throttling): a 503
here means the protocol is intentionally closed, and no amount of retrying by
the client changes that until an operator resumes it.

---

## Prerequisites

The control plane is disabled unless `KILLSWITCH_OPERATOR_TOKEN` is set. It is
**required in production** — a deploy without it fails validation, because a
protocol that cannot be paused is a protocol that cannot be safely operated.

```bash
export KS=http://localhost:4000/api/v1/ops/killswitch
export TOKEN=$(cat /run/secrets/killswitch_token)   # never paste into a ticket
export ME=alice
```

Every request needs two headers:

```
x-operator-token: $TOKEN
x-operator-id:    $ME     # who you are; this is the identity approvals count
```

Requests without a valid token get 401. With no token configured the routes
return 403.

---

## Pausing

```bash
# 1. Everything, immediately.
curl -sX POST "$KS/pause" \
  -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"global","reasonCode":"INCIDENT","reason":"Investigating abnormal fill rate"}'

# 2. One chain.
curl -sX POST "$KS/pause" -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"chain","chain":"stellar","reasonCode":"CHAIN_DEGRADED","reason":"RPC errors >20%"}'

# 3. One token.
curl -sX POST "$KS/pause" -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"token","chain":"base","token":"0xabc...","reasonCode":"TOKEN_DEPEGGED","reason":"USDC off peg"}'

# 4. One operation, all tokens on a chain.
curl -sX POST "$KS/pause" -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"operation","chain":"stellar","operation":"slash","reasonCode":"SOLVER_INCIDENT","reason":"registry anomaly"}'
```

`reasonCode` must be one of: `INCIDENT`, `TOKEN_DEPEGGED`, `SOLVER_INCIDENT`,
`CHAIN_DEGRADED`, `RPC_DEGRADED`, `REGULATORY`, `MAINTENANCE`.

Pausing is idempotent. Re-pausing an already-paused scope refreshes the reason
and **clears any pending approvals**.

### Previewing blast radius (read-only)

Before committing to a pause, ask what it would actually affect:

```bash
curl -sX POST "$KS/preview" -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"operation","chain":"stellar","operation":"fill"}'
```

The body takes the same `scope`/`chain`/`token`/`operation` shape as `/pause`,
minus `reasonCode`/`reason`. The preview is **read-only**: it never calls
`pause()`, never writes a row, and never activates anything. It runs the same
pure `evaluate()` matching logic against a synthetic hypothetical entry, so the
answer is exactly what a real pause would match.

```json
{
  "scope": "operation",
  "chain": "stellar",
  "operation": "fill",
  "windowSeconds": 300,
  "estimatedAffectedRequests": 18422,
  "matchedChain": "stellar",
  "overlappingSwitches": [
    { "scope": "chain", "chain": "stellar", "active": true, "reasonCode": "CHAIN_DEGRADED" }
  ]
}
```

- `estimatedAffectedRequests` is an estimate over a **recent window only**
  (default last 5 minutes), computed from the in-process Prometheus counters
  `MetricsService` already records — no extra scrape target, no load on
  Prometheus. It is bounded by whatever retention the metrics backend keeps;
  there is no historical backtesting.
- `overlappingSwitches` lists the *other* currently-active switches that would
  also govern the same requests (from `evaluate()`'s `matchedChain`). If this is
  non-empty, your new pause may be redundant under an already-active broader
  switch — consider whether you need it at all.

### Scheduled maintenance windows

For planned work (migrations, contract upgrades) you can schedule a one-shot
pause ahead of time and have it auto-resume without anyone clicking resume:

```bash
curl -sX POST "$KS/schedule" -H "x-operator-token: $TOKEN" -H "x-operator-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"scope":"operation","chain":"stellar","operation":"fill",
       "reasonCode":"MAINTENANCE","reason":"intents-store migration",
       "scheduledAt":"2025-08-27T02:00:00Z","autoResumeAt":"2025-08-27T02:30:00Z"}'
```

- `scheduledAt` — when the pause activates. `autoResumeAt` — when it lifts.
  Both are required and `autoResumeAt` must be after `scheduledAt`.
- This is distinct from `/pause`: nothing is paused at schedule time. A
  background timer on every replica checks for due transitions; the write is a
  conditional update, so a double-fire across replicas is harmless.
- **Auto-resume needs no approvals.** The resume time and scope were already
  operator-approved when the window was scheduled, so the two-operator rule
  does not apply to the scheduled lift.
- **Manual resume wins.** If an operator resumes the scope before
  `autoResumeAt`, the scheduled job finds the row no longer in its expected
  pre-state and skips cleanly — it will not error or re-pause.
- One-shot only: there is no recurring/cron-style window in v1.
=======

### What solvers experience

While `fill` is paused, the sweeper will not slash for a missed fill. Instead it
pushes the intent's fill deadline out by a full fill window and logs:

```
[sweeper] intent <id> fill is paused by a kill-switch — slashing suppressed and deadline extended to <ts>
```

This is deliberate: a solver must not lose bond for a pause the protocol
imposed. The intent becomes fillable again as soon as the pause is lifted.

---

## Resuming (two approvals)

Resuming requires **two distinct operators**. The second approval is what makes
an accidental resume during an active incident much less likely.

```bash
# First approval — the switch stays paused.
curl -sX POST "$KS/resume/$SWITCH_ID" -H "x-operator-token: $TOKEN" \
  -H "x-operator-id: $ME" -H 'content-type: application/json' \
  -d '{"note":"RPC healthy, 5m of clean reads"}'

# A different operator must also approve before it actually reopens.
curl -sX POST "$KS/resume/$SWITCH_ID" -H "x-operator-token: $TOKEN_2" \
  -H "x-operator-id: $BOB" -H 'content-type: application/json' \
  -d '{"note":"Confirmed, resuming fills"}'
```

The response tells you where you stand:

```json
{ "resumed": false, "approvals": 1, "required": 2 }
```

`approver` is taken from `x-operator-id`, **not** the request body, so one person
cannot satisfy both approvals by sending the request twice with different names.

### Resuming safely

Because evaluation is fail-closed across levels, resume order matters when a
pause spans several scopes. Clear the **broadest first**:

```
global  ->  chain  ->  token  ->  operation
```

Resuming an operation-level switch while a chain-level switch is still active
will not reopen anything — the chain switch keeps blocking. That is intentional,
not a bug.

---

## Observing

```bash
# Current state and propagation health.
curl -s "$KS" -H "x-operator-token: $TOKEN" | jq
```

```json
{
  "ready": true,
  "propagation": "redis",
  "lastUpdatedAt": 1756300000000,
  "switches": [ { "scope": "chain", "chain": "stellar", "active": true, "...": "..." } ],
  "scheduledWindows": [
    { "id": "sw_123", "scope": "operation", "chain": "stellar", "operation": "fill",
      "scheduledAt": 1756260000000, "autoResumeAt": 1756261800000, "state": "upcoming" }
  ]
}
```

`scheduledWindows` lists both **upcoming** windows (`state: "upcoming"`, not yet
active) and **currently-active** scheduled windows (`state: "active"`, paused
now and due to auto-resume at `autoResumeAt`), alongside the ad hoc `switches`.
=======

- `ready: false` means this replica has not loaded its snapshot. **Writes are
  being refused.** Check the database.
- `propagation: "db-poll"` means Redis is not in use; expect up to
  `KILLSWITCH_POLL_MS` of propagation delay.

Unauthenticated:

```bash
curl -s localhost:4000/health | jq '.killswitch'
```

`/health` deliberately stays `status: "ok"` during a pause — a pause is an
operational state, not an outage, and failing liveness would make Kubernetes
restart every replica mid-incident.

WebSocket clients receive an unsolicited frame when availability changes:

```json
{ "type": "protocol_status", "action": "paused", "paused": true,
  "scope": "chain", "chain": "stellar", "reasonCode": "CHAIN_DEGRADED",
  "reason": "RPC errors >20%", "seq": 4211 }
```

Use it to stop retry loops in the UI rather than showing a generic error.

---

## Incident checklist

1. **Pause** at the narrowest scope that covers the problem. Start narrow — you
   can always widen.
2. **Confirm** propagation: check `/health` on *every* replica, not just the one
   you called.
3. **Communicate** the `reason` and `reasonCode`; both are returned to clients.
4. **Investigate** with writes frozen.
5. **Get two approvals** from two different people to resume.
6. **Verify** the 503s stop and fills resume.

If a replica is stuck refusing writes with no active switch, check `ready` in
`/health` and the `Kill-switch` lines in the logs.

---

## Failure modes

| Symptom                                            | Cause                                            | Action                                                                     |
| -------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| 403 on every operator call                          | `KILLSWITCH_OPERATOR_TOKEN` unset                | Set the token; the control plane is disabled when empty, by design         |
| 401                                                | wrong/missing `x-operator-token`                 | Check the secret being presented                                            |
| Writes refused, no switch listed, `ready: false`   | snapshot load failing (usually DB)               | Fix the database; the service is fail-closed until it can load             |
| Resume says `resumed: false` forever               | same `x-operator-id` both times, or a re-pause    | Use two operators; check whether anything re-paused the switch            |
| Pause not taking effect on one replica              | poll/Redis degraded                               | Check `propagation` in `GET $KS`; raise `KILLSWITCH_REDIS_URL` coverage    |
| Pause lost after a restart                          | `KILLSWITCH_PERSISTENCE=memory`                  | Set `prisma`; in-memory state dies with the process                        |
| Scheduled window never activated                    | `scheduledAt` in the past / clock skew           | Check `scheduledWindows` in `GET $KS`; re-schedule with a future time      |
| Scheduled window did not auto-resume                | scope manually resumed first, or timer stalled   | Manual resume is expected to skip the job; otherwise check replica logs    |
| Preview shows 0 affected requests                   | no traffic in the recent window                  | Widen the window or check the scope matches real traffic                   |
=======

---

## Related

- `src/killswitch/killswitch.evaluate.ts` — the pure hierarchy rules
- `src/killswitch/killswitch.service.ts` — cache, propagation, scheduled windows
- `src/metrics/metrics.service.ts` — request counters backing `/preview`
=======
- `docs/adr/` — why evaluation is fail-closed across levels
- `docs/runbooks/on-call.md` — general on-call procedure
