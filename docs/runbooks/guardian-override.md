# Guardian Override Runbook (issue #507 — quorum break-glass)

The guardian override is the **break-glass path** for lifting an on-chain
emergency action (pause, freeze, blacklist) that the guardian contract raised
in error. Because a single compromised superadmin key is enough to undo the
strongest safety mechanism in the protocol, lifting a guardian action requires
a **quorum of distinct superadmins** — by default **two**.

---

## How it works

The override is a **two-phase flow**:

| Phase | Endpoint | Who calls it |
|-------|----------|--------------|
| 1 — Propose | `POST /api/v1/governance/guardian/actions/:id/override/propose` | Any superadmin |
| 2 — Approve | `POST /api/v1/governance/guardian/actions/:id/override/approve` | A **different** superadmin |

Once the number of distinct approvals reaches the configured threshold
(`guardian.overrideQuorum`, default 2) the action is lifted immediately.

Both phases are written to the admin audit log (`guardian.override.propose`,
`guardian.override.approve`, `guardian.override`). The override is **refused**
if the audit write fails.

### Constraints enforced

- The same admin **cannot** both propose and approve (or approve twice).
- Proposals expire after **30 minutes**. A stale half-approval cannot be
  completed; a new proposal must be raised.
- A new guardian event for the same key (e.g. a second on-chain pause)
  **cancels** any pending proposal — the guardian has spoken again.

---

## Prerequisites

```bash
export BASE=http://localhost:4000/api/v1
export KEY1=$(cat /run/secrets/superadmin_key_alice)   # never paste in a ticket
export KEY2=$(cat /run/secrets/superadmin_key_bob)
```

Both keys must have `superadmin` role in `ADMIN_API_KEYS`.

---

## Step-by-step

### 1. Identify the action id

```bash
curl -s "$BASE/governance/guardian/status" | jq '.guardianActions'
# [{ "id": "0000012345-0", "kind": "pause", "txHash": "abc...", ... }]
```

Copy the `id` field — that is the `:id` for the override endpoints.

### 2. Propose the override (superadmin Alice)

```bash
curl -sX POST "$BASE/governance/guardian/actions/0000012345-0/override/propose" \
  -H "x-admin-key: $KEY1" \
  -H "content-type: application/json" \
  -d '{"reason": "False positive — guardian fired on a benign price spike, confirmed by on-call."}'
```

Expected response (HTTP 202):
```json
{
  "proposal": {
    "actionId": "0000012345-0",
    "reason": "False positive ...",
    "proposedBy": "alice",
    "approvals": ["alice"],
    "expiresAt": 1700000000000
  },
  "quorumRequired": 2
}
```

The action is **still active** at this point.

### 3. Co-sign the override (superadmin Bob)

```bash
curl -sX POST "$BASE/governance/guardian/actions/0000012345-0/override/approve" \
  -H "x-admin-key: $KEY2" \
  -H "content-type: application/json"
```

Expected response (HTTP 200) once quorum is reached:
```json
{
  "proposal": { "approvals": ["alice", "bob"], ... },
  "executed": true,
  "quorumRequired": 2,
  "status": { "paused": false, "guardianActions": [] }
}
```

`executed: true` means the action has been lifted. If `executed: false` the
quorum threshold has not yet been reached (only relevant when `overrideQuorum > 2`).

### 4. Verify

```bash
curl -s "$BASE/governance/guardian/status" | jq '{paused: .paused, actions: .guardianActions}'
# { "paused": false, "actions": [] }
```

---

## Checking pending proposals

```bash
curl -s "$BASE/governance/guardian/status" | jq '.pendingOverrides'
```

Shows all non-expired pending proposals with their current approval count and
expiry timestamp. Use this to see if a co-sign is still needed.

---

## Configuration

| Env var / config key | Default | Description |
|---|---|---|
| `GUARDIAN_OVERRIDE_QUORUM` | `2` | Number of distinct superadmin approvals required |

Set in the application config (`guardian.overrideQuorum`). Raising it above 2
increases safety; lowering it to 1 restores the old single-admin behaviour
(not recommended in production).

---

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| 404 on propose | No active action with that id | Re-check `GET /status` — it may have self-cleared on-chain |
| 409 on propose | A non-expired proposal already exists | Use approve endpoint, or wait 30 min for expiry |
| 400 on approve | Same admin approving twice | A **different** superadmin must call approve |
| 404 on approve | Proposal expired or never created | Re-propose |
| 503 on either | Audit log DB unavailable | Fix database — the override is blocked until audit writes succeed |
| `executed: false` after approve | Quorum > 2 and not yet reached | More superadmins must call approve |

---

## Related

- `src/governance/guardian.service.ts` — `proposeOverride`, `approveOverride`
- `src/governance/guardian.controller.ts` — HTTP endpoints
- `src/admin/admin-audit.service.ts` — audit trail
- `docs/runbooks/killswitch.md` — operator-side emergency pause
