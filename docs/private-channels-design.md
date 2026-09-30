# Private WebSocket Channels - Design Document (Activity 3)

## Overview

Private channels enable delivery of solver-specific and user-specific events to authenticated connections only, preventing information leakage and enabling personalized notifications.

## Problem Statement

Currently, all WebSocket events are public. This creates two problems:

1. **Information Leakage:** Solver-specific events (RFQ wins, penalties, credential changes) are visible to all connected clients
2. **Missing Features:** User-specific notifications (quote wins, dispute updates) cannot be delivered at all

## Proposed Solution

Implement channel-based subscriptions with JWT-based authorization:

- `user:<address>` channels - User-specific events
- `solver:<address>` channels - Solver-specific events  
- `intents:public` - Public intent stream (current behavior)

## Architecture

### 1. Channel Registry

```typescript
interface ChannelRegistry {
  // Maps channel name → Set of authorized WebSocket clients
  private channels: Map<string, Set<WebSocket>>;
  
  // Subscribe client to channel with authorization check
  subscribe(client: WebSocket, channel: string, jwt: string): Result;
  
  // Unsubscribe client from channel
  unsubscribe(client: WebSocket, channel: string): void;
  
  // Broadcast event to all clients subscribed to channel
  broadcast(channel: string, event: Event): void;
}
```

### 2. Authorization Strategy

```typescript
interface ChannelAuthStrategy {
  // Check if JWT subject can subscribe to channel
  authorize(jwt: JWTClaims, channel: string): boolean;
}

class SolverChannelAuth implements ChannelAuthStrategy {
  authorize(jwt: JWTClaims, channel: string): boolean {
    // Channel format: "solver:GCZM...XYZ"
    const solverAddress = channel.split(':')[1];
    return jwt.sub === solverAddress;
  }
}

class UserChannelAuth implements ChannelAuthStrategy {
  authorize(jwt: JWTClaims, channel: string): boolean {
    // Channel format: "user:GCZM...XYZ"
    const userAddress = channel.split(':')[1];
    return jwt.sub === userAddress;
  }
}
```

### 3. Subscription Protocol

**Client subscribes to private channel:**
```json
{
  "type": "subscribe",
  "channels": ["solver:GCZM...XYZ", "intents:public"],
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Server response (success):**
```json
{
  "type": "subscribed",
  "channels": ["solver:GCZM...XYZ", "intents:public"]
}
```

**Server response (forbidden):**
```json
{
  "type": "subscribe_rejected",
  "channel": "solver:GDZX...ABC",
  "reason": "Unauthorized: JWT subject does not match solver address"
}
```

### 4. Private Events

Events routed to private channels:

**Solver-specific:**
- `solver_rfq_won` - RFQ assignment
- `solver_penalty_applied` - Slashing/penalty events
- `solver_credentials_updated` - API key rotation, permission changes
- `solver_bond_changed` - Bond deposit/withdrawal

**User-specific:**
- `user_quote_won` - Quote accepted by solver
- `user_dispute_opened` - Dispute initiated
- `user_dispute_resolved` - Dispute settled
- `user_intent_expired` - User's intent expired without fill

### 5. Backplane Integration

Extend backplane to support channel targeting:

```typescript
interface ChannelEvent extends SequencedEvent {
  channel: string;  // Target channel (e.g., "solver:GCZM...XYZ")
}

// Broadcast to specific channel
await backplane.publish({
  type: "solver_rfq_won",
  channel: "solver:GCZM...XYZ",
  rfqId: "rfq_123",
  intentId: "intent_456"
});
```

### 6. Replay Buffers

Separate replay buffers per channel type:

- **Public buffer:** All intents (existing behavior)
- **Solver buffers:** Per-solver events (keyed by address)
- **User buffers:** Per-user events (keyed by address)

```typescript
class ChannelReplayManager {
  private publicBuffer: EventRingBuffer;
  private solverBuffers: Map<string, EventRingBuffer>;
  private userBuffers: Map<string, EventRingBuffer>;
  
  replay(channel: string, fromSeq: number): SequencedEvent[] {
    if (channel === "intents:public") {
      return this.publicBuffer.since(fromSeq);
    }
    if (channel.startsWith("solver:")) {
      const address = channel.split(':')[1];
      return this.solverBuffers.get(address)?.since(fromSeq) ?? [];
    }
    // ... similar for user channels
  }
}
```

## Implementation Plan

### Phase 1: Infrastructure (Week 1)
- [ ] Implement ChannelRegistry
- [ ] Add authorization strategies
- [ ] Update backplane for channel targeting
- [ ] Add channel replay buffers

### Phase 2: Solver Channels (Week 2)
- [ ] Implement solver-specific events
- [ ] Update IntentsService to emit solver events
- [ ] Add solver channel authorization
- [ ] Write integration tests

### Phase 3: User Channels (Week 3)
- [ ] Implement user-specific events
- [ ] Update dispute/quote flows to emit user events
- [ ] Add user channel authorization
- [ ] Write integration tests

### Phase 4: Testing & Documentation (Week 4)
- [ ] E2E tests for private channels
- [ ] Load tests with mixed public/private subscriptions
- [ ] Update API documentation
- [ ] Update solver SDK with channel support

## Security Considerations

### 1. Token Expiry

JWT expiry mid-connection must revoke private subscriptions:

```typescript
// On token expiry (tracked via setTimeout)
channelRegistry.unsubscribeAll(client, 'solver:*');
channelRegistry.unsubscribeAll(client, 'user:*');

// Send notification to client
client.send(JSON.stringify({
  type: "token_expired",
  message: "Private channel subscriptions revoked"
}));
```

### 2. Rate Limiting

Private channel subscriptions count toward rate limits:

```typescript
// Max 10 channel subscriptions per connection
const MAX_PRIVATE_CHANNELS = 10;

if (filter.privateChannels.size >= MAX_PRIVATE_CHANNELS) {
  return { error: "max_private_channels_exceeded" };
}
```

### 3. Audit Logging

Log all private channel access:

```typescript
logger.info('private_channel_subscribed', {
  channel,
  subscriber: jwt.sub,
  ip: connectionState.ip,
  timestamp: Date.now()
});
```

## Breaking Changes

### Protocol Changes
- **New subscription format:** `{ channels: [...] }` replaces `{ chains: [...] }`
- **Backward compatibility:** Old clients continue working with `intents:public` implicit

### Migration Path

**Phase 1 (v1.0 - Current):**
- All events public
- Chain filtering via `{ chains: [...] }`

**Phase 2 (v1.1 - Transition):**
- Introduce private channels
- Support both old and new subscription formats
- Announce deprecation of old format

**Phase 3 (v2.0 - Breaking):**
- Remove old subscription format
- All clients must use channel subscriptions

## Configuration

New environment variables:

```bash
# Max private channels per connection
WS_MAX_PRIVATE_CHANNELS=10

# JWT secret for channel authorization (reuse existing)
AUTH_JWT_SECRET=your-secret-key

# Private channel event TTL (seconds)
PRIVATE_CHANNEL_REPLAY_TTL=3600
```

## Metrics

New Prometheus metrics:

```promql
# Active private channel subscriptions
vortex_ws_private_channels_active{channel_type="solver|user"}

# Private events delivered
vortex_ws_private_events_delivered_total{channel_type="solver|user"}

# Authorization failures
vortex_ws_channel_auth_failures_total{channel_type="solver|user",reason="expired|unauthorized"}
```

## Client Example (Solver SDK)

```typescript
import { VortexWsClient } from '@vortex/solver-sdk';

const client = new VortexWsClient({
  url: 'wss://api.vortex.trade/ws',
  jwt: solverJwt,
  channels: [
    'intents:public',           // Public intent stream
    `solver:${solverAddress}`,  // Solver-specific events
  ]
});

client.on('solver_rfq_won', (event) => {
  console.log('Won RFQ:', event.rfqId);
  // Submit quote...
});

client.on('solver_penalty_applied', (event) => {
  console.log('Penalty applied:', event.amount);
  // Handle slashing...
});
```

## Testing Strategy

### Unit Tests
- Channel authorization logic
- Token expiry handling
- Replay buffer per channel

### Integration Tests
- Subscribe to private channel with valid JWT
- Reject subscription with invalid JWT
- Revoke subscription on token expiry
- Replay private events

### E2E Tests
- Multi-channel subscription
- Mixed public/private event delivery
- Authorization matrix (solver A cannot see solver B events)

### Load Tests
- 10k connections with 50% private subscriptions
- Private event fanout performance
- Memory overhead of per-channel buffers

## Out of Scope

### Not Included in This Activity
- ❌ E2E encryption (client-to-client encryption)
- ❌ Message signing (tamper detection)
- ❌ Channel presence (who else is subscribed)
- ❌ Direct messaging (client-to-client)

### Future Enhancements
- Rate limiting per channel
- Channel-level permissions (read/write)
- Webhook integration for offline delivery
- Mobile push notifications

## Rollback Plan

If issues arise after deployment:

1. **Feature flag:** Disable private channels via flag
2. **Fallback:** All events revert to public stream
3. **No data loss:** Public buffer continues working
4. **Client impact:** Graceful degradation (no crashes)

## Success Metrics

- [ ] Zero information leakage (solver A cannot see solver B events)
- [ ] Authorization latency < 10ms
- [ ] Private event delivery latency < public events
- [ ] Memory overhead < 100MB at 10k connections
- [ ] No performance regression for public-only clients

## Timeline

- **Design Review:** Week 1
- **Implementation:** Weeks 2-4
- **Testing:** Week 5
- **Staging Deploy:** Week 6
- **Production Rollout:** Week 7 (canary → full)

## References

- WebSocket Channels Pattern: https://socket.io/docs/v4/rooms/
- JWT Best Practices: https://datatracker.ietf.org/doc/html/rfc8725
- Channel Authorization: https://pusher.com/docs/channels/server_api/authenticating-users/

## Status

- **Phase:** Design / Architecture
- **Implementation:** Deferred to separate PR
- **Reason:** Breaking protocol changes require careful migration planning
- **Next Steps:** Review design → Approve → Implement in dedicated sprint

---

**Author:** Kiro AI Agent  
**Date:** 2026-09-29  
**Activity:** #3 - Private WebSocket Channels  
**Status:** Design Complete, Implementation Pending
