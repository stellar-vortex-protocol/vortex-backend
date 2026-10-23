# Runbook: log-based security alerts

Issue #488. These alerts are evaluated by the Loki ruler over the structured log stream
(`ops/observability/loki-rules/fake/vortex-security.yml`). Field names are documented in
[`docs/observability/logging.md`](../observability/logging.md).

Start every investigation in Grafana → Explore → Loki with:

```logql
{service_name="vortex-backend"} | json | event="<event from the alert>"
```

and pivot on `requestId` / `traceId` to see the full request.

## Signature failure spike

`VortexSignatureFailureSpike` — more than 50 `security.signature_failure` records in 5 minutes.

1. Break down by `scheme`, `reason` and `messageKind`:
   `sum by (reason, messageKind) (count_over_time({service_name="vortex-backend"} | json | event="security.signature_failure" [15m]))`
2. **One `messageKind`, many signers, starting at a deploy** — a client or SDK release is signing the wrong
   message. Compare against the message builders in `src/common/stellar-signature.ts`; roll back the
   client, not the backend.
3. **`reason="malformed"` dominating** — scanners or fuzzers. Confirm they are being rate-limited
   (`vortex_http_requests_total{status="401"}`); no action unless the rate threatens capacity.
4. **Few signers, `reason="mismatch"`** — someone is trying to act as another address. Go to
   [single signer](#single-signer).

## Single signer

`VortexSignatureFailuresSingleSigner` — more than 20 failures claiming one address in 10 minutes.

1. Look up the address: is it a registered solver (`GET /api/v1/solvers/<address>`) or a user with open
   intents?
2. Pull the client IPs for the matching `requestId`s from the ingress logs.
3. If it is a solver, tell the solver operator — their key handling may be broken, or someone is
   impersonating them. Abuse controls: `docs/runbooks/on-call.md`.

## Signer policy violation

`VortexSignerPolicyViolation` — the signer policy denied a transaction. This pages on the first event:
the policy should never have to say no in normal operation.

1. Read `reason` (`classic_payment_forbidden`, `inclusion_fee_exceeded:…`, `auth_entry_not_allowed`,
   `budget_exceeded:…`) and `wallet`.
2. `budget_exceeded` during a known backlog drain can be expected — confirm with the outbox backlog
   (`docs/runbooks/on-call.md#scenario-g--outbox-rows-dead-or-backlogged`).
3. Anything else means code tried to sign something it should not. Engage the kill switch for on-chain
   writes (`docs/runbooks/killswitch.md`) until the source is understood.

## Admin auth failures

`VortexAdminAuthFailures` — more than 10 rejected admin-key attempts in 5 minutes.

1. `reason="missing_key"` from internal IPs is usually a misconfigured script. `invalid_key` from the
   internet is key guessing.
2. Confirm admin routes are not exposed beyond the operator network.
3. If guessing continues, block the source at the edge and rotate `ADMIN_API_KEYS` as a precaution.

## Admin action anomaly

`VortexAdminActionAnomaly` / `VortexAdminActionFanOut` — a burst of `admin.action` records.

1. Check the incident channel: an operator working an incident (pausing tokens, flipping flags) is the
   common cause. Acknowledge if so.
2. Otherwise group by `actor` and `action`. An actor nobody recognises, or one acting outside working
   hours, may be a leaked key: revoke it in `ADMIN_API_KEYS` immediately, then review its
   `admin_audit_log` rows and revert unexpected changes.
