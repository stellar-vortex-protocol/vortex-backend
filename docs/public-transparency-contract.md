# Public transparency contract

The public protocol transparency endpoint is intentionally designed as a stable contract for community dashboards and external reporting.

## Endpoint

- GET /api/v1/stats/public

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
