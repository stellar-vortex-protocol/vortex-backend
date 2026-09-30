# ADR 0003: Oracle-referenced minDstAmount validation

- **Status**: Accepted
- **Date**: 2026-09-29
- **Technical Story**: #434 — reject dangerously low and unfillable high `minDstAmount` values on intent creation

## Context

Intent creation previously accepted any positive integer `minDstAmount`. A
minimum far below oracle fair value lets a solver fill at the user's expense.
A minimum far above fair value can never fill and wastes solver attention.

Token amounts are integer base units with heterogeneous decimals (6 / 7 / 18).
Fair value must therefore be computed in `bigint`, not IEEE-754 floats.

## Decision

1. `AggregatorService` produces a `PriceSnapshot` (USD prices at 8-decimal
   scale plus `asOfMs`) from the token registry.
2. `validateMinDstAmount` is a pure function of the snapshot, amounts, and
   config so tests do not need live RPC.
3. Slippage above `MAX_USER_SLIPPAGE_BPS` is rejected unless the user sets
   `acknowledgeHighSlippage: true` and signs
   `acknowledge-high-slippage:<user>:<srcAmount>:<minDstAmount>`.
4. Premium above `MAX_PREMIUM_BPS` is always rejected.
5. When the oracle is missing or stale, intents with source notional at most
   `ORACLE_FAIL_OPEN_MAX_USD` fail-open; larger notionals fail-closed.
6. No MEV protection is applied on the Stellar leg.

Create responses include `fairValue` (dst base units, or null on fail-open)
and `slippageBps`.

## Consequences

- Integrators that posted 6-decimal-style minima against 7-decimal Stellar
  USDC will now be rejected unless they acknowledge high slippage.
- Operators tune `MAX_USER_SLIPPAGE_BPS`, `MAX_PREMIUM_BPS`,
  `ORACLE_FAIL_OPEN_MAX_USD`, and `ORACLE_MAX_STALENESS_MS`.
