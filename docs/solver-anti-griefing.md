# Anti-Griefing Controls (issue #453)

A griefing solver can accept many intents it never intends to fill, locking
user funds for the whole fill window while paying at most one slash per
intent. These controls are the **pre-slash** defence: they limit the blast
radius before the on-chain slash is ever reached.

Out of scope: on-chain penalties beyond the existing slashing.

---

## Table of Contents

1. [Detection model](#detection-model)
2. [Escalation ladder](#escalation-ladder)
3. [Enforcement and error codes](#enforcement-and-error-codes)
4. [Incident exclusions](#incident-exclusions)
5. [Configuration](#configuration)
6. [Observability](#observability)
7. [Operator runbook](#operator-runbook)
8. [Design notes and limits](#design-notes-and-limits)

---

## Detection model

Per solver, over a rolling window:

```
unfilled ratio = unfilled / (filled + unfilled)
```

- An outcome is **recorded when an accept is resolved**: `POST
  /api/v1/intents/:id/fill` records `filled`, and the sweeper's slash of a
  missed fill records `unfilled` (see `IntentsSweeperService.slashMissedFill`).
- Accepts that are still inside their fill window are *not* counted — they are
  already constrained by the fill deadline and by the concurrency cap.
- Failures that fall inside an admin-declared incident are dropped entirely
  (see [Incident exclusions](#incident-exclusions)).

The ratio is only *acted on* once a solver has at least
`ANTIGRIEFING_MIN_SAMPLES` resolved accepts in the window, so a solver with
one unlucky failure is never punished for statistical noise.

---

## Escalation ladder

| Tier | Control | Applies while |
|---|---|---|
| 0 | none | default |
| 1 | **cooldown** — `POST /:id/accept` returns 429 | `ANTIGRIEFING_COOLDOWN_SECONDS` from the escalation |
| 2 | **concurrency cap** — at most `ANTIGRIEFING_CONCURRENCY_CAP` intents in `accepted` state at once (plus a cooldown) | until the ratio recovers or an operator clears it |
| 3 | **suspension** — `POST /:id/accept` returns 403 | `ANTIGRIEFING_SUSPENSION_SECONDS`, or until an operator clears it when that value is `0` |

Rules:

- A tier moves **one step at a time**, and only when the ratio is at or above
  `ANTIGRIEFING_RATIO_THRESHOLD` (default `0.5`).
- While a cooldown is running the solver is not escalated again — one tier per
  breach, so escalation takes repeated bad stretches rather than a single burst.
- When the ratio falls to `ANTIGRIEFING_RECOVERY_RATIO` (default `0.2`) the
  solver steps **down** one tier, so an honest solver with a bad streak is not
  punished forever.
- A lapsed tier-3 suspension re-suspends on the next unfilled accept; there is
  no third chance after the third.

---

## Enforcement and error codes

Enforcement happens in `IntentsController.accept`, **after** the existing
guards (404 → kill-switch pause → expiry → signature → registration → canary)
and **immediately before** the atomic `acceptIfOpen` write. A refused accept
therefore never mutates intent state.

Every refusal carries a stable machine-readable `code`:

| HTTP | `code` | Meaning | Extras |
|---|---|---|---|
| 429 | `ANTIGRIEFING_COOLDOWN` | Tier-1/2 cooldown is running | `Retry-After`, `cooldownUntil`, `retryAfterSeconds` |
| 429 | `ANTIGRIEFING_CONCURRENCY_LIMIT` | Tier 2 and the solver already has `ANTIGRIEFING_CONCURRENCY_CAP` intents accepted | `openAccepts`, `concurrencyCap` |
| 403 | `ANTIGRIEFING_SUSPENDED` | Tier 3 | `suspendedUntil`, `indefinite` |

Example body:

```json
{
  "error": "Solver is cooling down after repeated accept-without-fill behaviour",
  "code": "ANTIGRIEFING_COOLDOWN",
  "solver": "G...",
  "intentId": "...",
  "level": 1,
  "cooldownUntil": 1767225600000,
  "retryAfterSeconds": 300
}
```

Clients should branch on `code` (never on `error`), and honour `Retry-After`.

---

## Incident exclusions

Legitimate failures caused by a chain outage must not count against solvers.
An admin declares an incident:

```bash
# cover one chain
curl -X POST $BASE/admin/anti-griefing/incidents \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"chain":"ethereum","reason":"RPC provider outage"}'

# cover every chain
curl -X POST $BASE/admin/anti-griefing/incidents \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"reason":"sequencer outage"}'
```

While the incident is open, unfilled accepts on the covered chains are neither
counted nor audited as failures (they are audited as `incident_excluded`).

```bash
curl -X POST $BASE/admin/anti-griefing/incidents/$ID/end \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"excludeUntil":1767225600000}'
```

Slashing is detected by the sweeper, which can run well after a chain
recovers. `excludeUntil` (epoch ms) extends coverage past the closure instant
so those late-detected failures stay excused; it defaults to the closure time,
i.e. only failures *during* the incident.

---

## Configuration

All thresholds live in `.env.example` (and the `.env.*.example` variants) and
are validated by `src/config/env.validation.ts`.

| Variable | Default | Effect |
|---|---|---|
| `ANTIGRIEFING_ENABLED` | `true` | Master switch. `false` disables enforcement *and* tracking |
| `ANTIGRIEFING_WINDOW_SECONDS` | `86400` | Rolling window for the ratio |
| `ANTIGRIEFING_MIN_SAMPLES` | `10` | Resolved accepts required before a tier applies |
| `ANTIGRIEFING_RATIO_THRESHOLD` | `0.5` | Ratio that escalates a tier |
| `ANTIGRIEFING_RECOVERY_RATIO` | `0.2` | Ratio that steps a tier back down |
| `ANTIGRIEFING_COOLDOWN_SECONDS` | `300` | Length of each cooldown |
| `ANTIGRIEFING_CONCURRENCY_CAP` | `2` | Concurrent accepted intents from tier 2 |
| `ANTIGRIEFING_SUSPENSION_SECONDS` | `3600` | Suspension length; `0` = until cleared by an operator |

`npm run check:env-drift` fails if any of these is missing from one of the
three places above.

---

## Observability

Prometheus (`GET /metrics`), all `vortex_` prefixed:

| Metric | Labels | Meaning |
|---|---|---|
| `vortex_antigriefing_actions_total` | `solver`, `action` | Tiers applied (`cooldown`, `concurrency_cap`, `suspended`, `recovered`, `manual_reset`). `solver` is truncated to 12 chars to bound cardinality |
| `vortex_antigriefing_blocked_total` | `code` | Refused accepts per error code |
| `vortex_antigriefing_unfilled_ratio` | `solver` | Latest rolling ratio — the dashboard series |
| `vortex_antigriefing_incidents_excluded_total` | — | Failures excused by an incident |

HTTP endpoints:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/solvers/:address/anti-griefing` | public | Per-solver status: tier, ratio, cooldown, cap, reputation multiplier |
| `GET /admin/anti-griefing/statuses` | `x-admin-key` | Same for every tracked solver |
| `GET /admin/anti-griefing/audit` | `x-admin-key` | Audit trail (`?solver=`, `?limit=`) |
| `GET /admin/anti-griefing/incidents` | `x-admin-key` | Declared incidents |
| `POST /admin/anti-griefing/incidents` | `x-admin-key` | Open an incident |
| `POST /admin/anti-griefing/incidents/:id/end` | `x-admin-key` | Close an incident |
| `POST /admin/anti-griefing/solvers/:address/reset` | `x-admin-key` | Clear every control on a solver |

**Reputation impact.** The leaderboard and per-solver stats multiply
`reputationScore` by a tier multiplier (`1 / 0.9 / 0.7 / 0.5` for tiers 0–3),
so a punished solver also ranks lower. The multiplier is `1` for every
unpunished solver, so existing rankings are unchanged.

---

## Operator runbook

**A chain outage is slashing honest solvers.**
Open an incident immediately (`POST /admin/anti-griefing/incidents`). Failures
recorded while it is open are dropped. Close it with `excludeUntil` set to the
time the chain actually recovered if the sweeper has not yet caught up.

**A solver was punished unfairly** (e.g. a router bug made it miss fills):

```bash
curl -X POST $BASE/admin/anti-griefing/solvers/$ADDR/reset \
  -H "x-admin-key: $ADMIN_KEY"
```

This clears cooldown/cap/suspension but **keeps** the rolling window, so the
evidence the decision was based on survives the reset. Both actions are
written to the service audit trail and to `admin_audit_log`.

**Everything is under attack and the controls are too noisy.**
Set `ANTIGRIEFING_ENABLED=false` and restart. Enforcement and tracking both
stop; nothing else changes.

---

## Design notes and limits

- **In-process state.** Each replica tracks the accepts *it* served. A restart
  clears tiers (degrading to "no control", never to "blocks everybody"), and
  two replicas can disagree for one window. Cross-replica state would need the
  shared store introduced by issue #457 (`ReplayStore`) and is deliberately not
  part of #453.
- **The cap is counted from intent state**, not from local bookkeeping:
  `assertCanAccept` receives a lazy `openAccepts` backed by
  `IntentsService.getAcceptedCountBySolver`, which reflects the atomic
  `acceptIfOpen`/`fillIfAccepted` transitions. It is only resolved on the
  tier-2+ path, so unpunished solvers never pay for the scan.
- **No new breaking change**: existing accept responses keep their shape; only
  the new coded 429/403 bodies are added.
- Tests: `src/solvers/anti-griefing.service.spec.ts` (griefing simulation,
  fairness, thresholds, cooldowns, concurrency, incident exclusions),
  `src/intents/intents.accept-antigriefing.spec.ts` (accept-path ordering),
  `src/intents/intents-sweeper.service.spec.ts` (unfilled wiring).
