# PR Description: Add Topic-Based Subscriptions to the WebSocket Gateway

## Issue Reference

- Closes #79

## PR Links

- PR #161: https://github.com/stellar-vortex-protocol/vortex-backend/pull/161
- Branch: `feature/ws-topic-subscriptions`

## Summary

`IntentsGateway.broadcast()` sends every event to every connected subscriber unconditionally. A solver bot only interested in stellar intents still receives the full firehose across all seven `SupportedChain` values. This PR adds topic-based filtering so subscribers can receive only the events they care about.

## Changes

### Modified File: `src/intents/intents.gateway.ts`

- Changed `subscribers` from `Set<WebSocket>` to `Map<WebSocket, SubscriberFilter>` to track per-subscriber chain filters
- Added `handleMessage()` private method that processes incoming WebSocket messages
- Clients can send `{ type: "subscribe", chains: ["stellar"] }` after connecting to filter events
- `broadcast()` now checks each subscriber's filter before sending; events whose chain doesn't match the subscriber's filter are skipped
- Added `getEventChain()` helper that resolves the chain from events:
  - For `intent_created` events, reads `srcChain` directly from the intent object
  - For `intent_filled`, `intent_accepted`, `intent_cancelled`, and `intent_expired` events, looks up the intent via `IntentsService.get()` to resolve `srcChain`
  - Returns `null` for events without a chain, which are always delivered to all subscribers

### Modified File: `scripts/solver-bot.ts`

- Added `SOLVER_CHAINS` environment variable (defaults to all supported chains)
- Bot subscribes to configured chains after connecting via `{ type: "subscribe", chains: [...] }`
- Bot handles the `subscribed` confirmation event
- Bot skips intents on non-subscribed chains in `tryFillOpenIntent()` with a log message

## Verification

- `npm run lint` passes
- `npm run typecheck` passes
- `npm test` passes
- `npm run test:e2e` passes

## Acceptance Criteria

- [x] Subscribe/filter message implemented for WebSocket clients
- [x] Per-subscriber chain filters tracked in the subscribers map
- [x] `broadcast()` filters events by subscriber's chain filter
- [x] `solver-bot.ts` updated to demonstrate topic-based filtering
- [x] PR description includes "Closes #79"