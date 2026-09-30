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
