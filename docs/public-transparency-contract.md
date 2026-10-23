# Public transparency contract

The public protocol transparency endpoint is intentionally designed as a stable contract for community dashboards and external reporting.

## Endpoints

### GET /api/v1/stats/public

Public protocol metrics endpoint with a reproducible provenance block. The payload remains additive and stable; callers should treat the response as canonical for the current snapshot, with provenance metadata describing the watermark, generation time, query version, dataset URL, and a signature over the canonical payload.

Example payload:
```json
{
  "totalIntents": 42,
  "openIntents": 7,
  "totalVolume": "123456",
  "uniqueUsers": 18,
  "activeSolvers": 5,
  "avgFillTime": 120,
  "fillRate": 0.4,
  "provenance": {
    "watermarkLedger": 0,
    "generatedAt": "2026-09-28T00:00:00.000Z",
    "queryVersion": "public-stats/v1",
    "datasetUrl": "https://example.invalid/public-stats/latest.json",
    "signature": "<hex-digest>"
  }
}
```

### GET /api/v1/stats/public/history

List of signed public snapshots captured over time for independent verification and audit trails.

### GET /api/v1/treasury/reconciliation

Treasury reconciliation summary endpoint showing expected vs actual treasury balances per asset. Added to support governance decisions and public reporting with on-chain verification.

**Query Parameters:**
- `date` (optional): Date in YYYY-MM-DD format (defaults to today)

**Response:**
```json
{
  "date": "2026-09-28",
  "assets": [
    {
      "asset": "native",
      "expectedBalance": "1000000000",
      "actualBalance": "1000500000",
      "discrepancy": "500000",
      "discrepancyPercentage": 0.05,
      "hasUnexplainedDiscrepancy": false,
      "explanation": "Discrepancy within tolerance threshold..."
    }
  ],
  "totalDiscrepancies": 3,
  "assetsWithUnexplainedDiscrepancies": 1,
  "lastReconciliationAt": "2026-09-28T00:00:00.000Z"
}
```

## Self-service abuse score transparency (issue #607)

Users who are unexpectedly throttled or challenged by the abuse detector have a
self-service path to view their own current score and recent signals without
contacting support. These endpoints are intentionally **additive and separate**
from the admin-only endpoints — they expose a reduced view that never reveals
raw IP addresses or other actors' data.

### GET /api/v1/abuse/me/score

Returns the caller's current cached abuse score.

**Authentication:** Stellar Ed25519 signed-message proof. The caller must include:

| Header | Description |
|--------|-------------|
| `X-Vortex-Address` | Stellar G-address of the caller |
| `X-Vortex-Signature` | Base64 Ed25519 signature over the canonical message |
| `X-Vortex-Nonce` | UUID or unique string; prevents replay |
| `X-Vortex-Expires-At` | Unix timestamp (seconds) when the nonce expires |

**Canonical message:** `abuse-self-service:<address_lowercase>:<nonce>:<expiresAt>`
(built by `buildAbuseSelfServiceMessage` in `src/common/stellar-signature.ts`).
Sign the UTF-8 bytes with the address's Ed25519 key and send the signature base64-encoded.

The address that is queried is always the verified signer. There is no path or
query parameter naming an address, so a valid signature for one address cannot
be used to read another address's data.

**Example response:**
```json
{
  "address": "gabcdef...",
  "score": 45
}
```

### GET /api/v1/abuse/me/audit

Returns the caller's own abuse audit history as a reduced view. Signal names
and timestamps are included; raw IP addresses and internal signal details are
excluded.

**Authentication:** Same signed-message scheme as `/me/score`.

**Query Parameters:**
- `limit` (optional, default 20, max 100): Number of events to return.

**Example response:**
```json
{
  "address": "gabcdef...",
  "events": [
    {
      "timestamp": "2026-10-20T11:00:00.000Z",
      "operation": "create",
      "action": "throttle",
      "signals": [
        { "signal": "ip_asn_cluster", "weight": 25 }
      ]
    }
  ]
}
```

### Replay protection

Each `(address, nonce)` pair is consumed exactly once, in the same nonce store
used for intent signatures (namespaced so the two never collide). The nonce is
consumed only after the signature verifies, so a forged request cannot use up
a real caller's nonce. A second request with the same nonce returns 401
`Unauthorized`. `X-Vortex-Expires-At` must be no more than 5 minutes in the
future (60 s clock skew is tolerated either way).

All failures (missing header, bad signature, expired, replay) return 401.

### What is deliberately excluded from the self-service view

The response shape is `AbuseSelfAuditEvent` in `src/abuse/abuse.types.ts`, a
type separate from the admin `AbuseAuditEvent`. Fields are copied one by one,
so a field added to the admin view later does not appear here unless someone
adds it on purpose.

- Raw `clientIp` addresses (could deanonymise unrelated traffic).
- Internal signal `detail` strings (operator-facing notes).
- The numeric `score` field per event (only the action is returned).
- Data for any address other than the authenticated caller.

## Stability policy

The contract is versioned by path and field set rather than by silent mutation. In practice, this means:

- additive fields are allowed without a version bump;
- renaming or removing existing fields requires a new versioned path or a deliberate contract bump;
- breaking response-shape changes should be treated as a new public contract version, not as an in-place change to the existing contract.

This policy keeps community dashboards predictable while still allowing the backend to evolve. The public endpoint should therefore be treated as a semver-style public API surface: the contract is stable, documented, and intentionally conservative.

## Current payload

The endpoint returns:

- totalIntents
- openIntents
- filledIntents
- totalVolume
- activeSolverCount
- wsSubscriberCount
- perChain summary
- contract name and schema version metadata
