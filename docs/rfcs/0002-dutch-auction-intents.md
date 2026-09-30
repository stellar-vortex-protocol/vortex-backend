# RFC 0002: Dutch-auction intent allocation

- Status: Proposed
- Issue: #447

## Summary

Allow an intent to include a Dutch auction price curve that decays from a
configured destination amount to `minDstAmount`. Optionally reserve a short
initial acceptance window for one solver. Auction pricing is deterministic,
off-chain, and calculated with integer arithmetic.

## Motivation

First-come-first-served acceptance rewards response latency rather than price.
An auction gives solvers time to compete while preserving the user's minimum
acceptable output and gives every participant one canonical price at accept.

## Proposed change

An intent may carry `auction: { startDstAmount, decayStart, decayEnd,
exclusiveSolver?, exclusivityEnd? }`. Before `decayStart`, the price is
`startDstAmount`; between the endpoints it linearly decays using `bigint`; at
and after `decayEnd`, it is `minDstAmount`. Creation validates the amount and
time bounds, and requires exclusive solver/end fields together with a maximum
five-minute exclusivity window.

The atomic open-to-accepted database update stores `acceptedDstAmount`. A fill
must meet that amount even if the live auction price later falls. The REST
`GET /api/v1/intents/:id/auction` endpoint reports the current price, and the
WebSocket backplane broadcasts changed prices no more than once every five
seconds. The persisted accepted amount is also the future contract-integration
hook; this RFC does not claim on-chain enforcement.

## Alternatives considered

- Floating-point interpolation was rejected because large base-unit amounts
  lose precision.
- Recomputing the acceptance price during fill was rejected because a falling
  price after accept would weaken the solver's commitment.
- On-chain auction enforcement is deferred until the settlement contract has a
  matching auction interface.

## Backward-compatibility impact

The optional auction fields are additive. Existing intents retain their
current behavior. A nullable JSONB column and nullable accepted-price column
are added; the WebSocket protocol gains an `auction_price` event.

## Related work

- Issue #447.
- `src/auctions/dutch.ts` and the intent accept/fill flow.