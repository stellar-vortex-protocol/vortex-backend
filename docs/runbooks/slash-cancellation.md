# Runbook — Solver Slash Review and Manual Cancellation

Issue #397. Applies to the slashing saga in
`src/intents/slashing-pipeline.service.ts`.

## How a slash flows

```
detected ──▶ challenge_window ──(window over + re-verified)──▶ submitted ──▶ confirmed
                  │                                                 │
                  └──── fill proof / admin / give-up ──▶ cancelled ◀┘ (tx failed past retries)
```

1. The sweeper finds an `accepted` intent past its fill deadline, marks it
   `slashed`, bumps the solver's `fillsFailed` optimistically, and records a
   row in `pending_slashes` (unique per `intent_id`, so exactly-once).
2. The row sits in `challenge_window` for `SLASH_CHALLENGE_WINDOW_SECONDS`
   (default 600 s). **Nothing is sent on-chain during the window.**
3. When the window ends the pipeline re-checks the settlement contract's
   `intent_filled` events. A fill whose **ledger close time** is at or before
   `fillDeadline + SLASH_CLOCK_SKEW_TOLERANCE_SECONDS` cancels the slash. If
   the check itself fails (RPC down) the slash is retried later, never
   submitted blind.
4. Otherwise `SolverRegistryService.slashSolver` is called and the row
   becomes `submitted`, then `confirmed` once the transaction lands.

Every cancellation runs the compensation exactly once: `fillsFailed` is
reverted (`SolversService.rollbackPenalty`) and the intent leaves `slashed`
(`filled` if a fill was proven, otherwise `expired`). An
`intent_slash_cancelled` WebSocket event and an audit-log entry are emitted.

## Inspecting slashes

```bash
# One intent (public)
curl -s $API/api/v1/slashes/<intentId> | jq

# Everything waiting in the window (admin)
curl -s -H "x-admin-key: $ADMIN_KEY" \
  "$API/api/v1/admin/slashes?state=challenge_window" | jq
```

Admin routes use the shared admin RBAC (`AdminGuard`): send your key in the
`x-admin-key` header. Keys come from `ADMIN_API_KEYS` (`id:role:secret`); when
it is empty every admin route returns 401. The key's `id` is recorded as the
actor in the audit log.

## Cancelling a slash manually

Use when the slash is wrong — e.g. the fill landed on-chain but the event was
late, the solver's fill was blocked by a protocol incident, or the intent's
deadline was misconfigured.

```bash
curl -s -X POST -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"note":"<why — goes in the audit log>"}' \
  "$API/api/v1/admin/slashes/<intentId>/cancel" | jq
```

Responses:

| Status | Meaning | Action |
|---|---|---|
| 200 | Cancelled and compensated | Verify below |
| 404 | No slash for that intent | Check the intent id |
| 409 `submission in progress` | A worker holds the lease and may be broadcasting right now | Retry in ~2 minutes |
| 409 `state=submitted` / `confirmed` | Already broadcast — the backend can no longer stop it | Escalate: reversal must happen on-chain / via governance (out of scope here) |

Verify:

```bash
curl -s $API/api/v1/slashes/<intentId> | jq '.state, .cancelReason, .cancelledBy'
curl -s $API/api/v1/intents/<intentId>/audit | jq '.[-1]'
curl -s $API/api/v1/solvers/<solverAddress> | jq '.fillsFailed'
```

**Buying time:** if you need longer than the window to investigate a batch of
slashes, raise `SLASH_CHALLENGE_WINDOW_SECONDS` and restart. The new window
only applies to newly detected slashes; cancel existing ones individually.

## Solver-initiated cancellation (fill proof)

A solver whose fill landed in time can cancel during the window without
operator involvement:

```
POST /api/v1/slashes/<intentId>/fill-proof
{ "solver": "G...", "txHash": "<64 hex>", "signature": "<base64>" }
```

`signature` is the solver's Ed25519 signature of
`fill-proof:<intentId>:<solver>:<lowercase txHash>`. The tx must be
successful, have closed by `fillDeadline + tolerance`, and emit
`intent_filled` for the intent from the settlement contract.

## Submit-failed slashes

Alert `VortexSlashSubmitFailed` fires when a slash was cancelled with reason
`submit_failed` after `SLASH_MAX_SUBMIT_ATTEMPTS` failures (RPC outage,
simulation errors). The solver was **not** penalised and the compensation has
already run. Check logs for `[slashing] ALERT giving up`, fix the root cause
(RPC, signing key, registry contract id), and decide with the service owner
whether the miss warrants a governance-level penalty.

## Known limitations

- While `ONCHAIN_DRY_RUN=true`, or until the registry submit path is un-gated
  (issue #23), slashes stop at `submitted` with `simulated=true` and are never
  confirmed. That is expected.
- `solver deregistered mid-window` does **not** cancel the slash —
  deregistration must not be an escape hatch.
