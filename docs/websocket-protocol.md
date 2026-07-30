# WebSocket Protocol Reference

The Vortex backend exposes a real-time intent feed over WebSocket at:

```
ws://localhost:4000/ws
```

The feed is **public and read-only**. Any client may connect and receive
events without credentials. Writes (accept, fill, cancel) use the
authenticated REST API.

---

## Connection

Open a WebSocket connection to `/ws`. On connect the server immediately sends
a `connected` event followed by a `snapshot` of all currently open intents.

```ts
const ws = new WebSocket("ws://localhost:4000/ws");
```

### Max connections

The server cap is controlled by `WS_MAX_CONNECTIONS` (default `1000`, `0` =
unlimited). Connections beyond the cap are closed with code `1013`
(_Try Again Later_, RFC 6455) before any message is sent.

---

## Message format

Every message is a JSON object with a `type` field discriminating the event
kind, plus a monotonically increasing `seq` integer used for gap detection
and replay.

```ts
interface BaseEvent {
  type: string;
  seq: number;
}
```

All field types are TypeScript unless noted otherwise.

---

## Server → Client events

### `connected`

Sent immediately after the TCP handshake completes. Carries the server's
current sequence counter so the client can track gaps from the very first
message.

```jsonc
{
  "type": "connected",
  "message": "Vortex intent stream",
  "seq": 42          // highest seq the server has emitted so far
}
```

| Field     | Type     | Description                            |
|-----------|----------|----------------------------------------|
| `message` | `string` | Human-readable greeting                |
| `seq`     | `number` | Server's current sequence number       |

---

### `snapshot`

Sent immediately after `connected`. Contains up to 20 currently open intents.
Clients should use this as their starting state and then apply subsequent
delta events.

```jsonc
{
  "type": "snapshot",
  "intents": [ /* Intent[] — see Intent shape below */ ],
  "seq": 42
}
```

| Field     | Type       | Description                              |
|-----------|------------|------------------------------------------|
| `intents` | `Intent[]` | Up to 20 intents in `open` state         |
| `seq`     | `number`   | Sequence number at snapshot time         |

---

### `subscribed`

Acknowledgement sent after the server processes a `subscribe` message from
the client. Reflects the filter that was applied.

```jsonc
{
  "type": "subscribed",
  "filter": {
    "chains": ["ethereum", "base"]   // omitted when no chain filter is active
  }
}
```

| Field    | Type                | Description                          |
|----------|---------------------|--------------------------------------|
| `filter` | `SubscriberFilter`  | Active filter for this connection    |

`SubscriberFilter`:

```ts
interface SubscriberFilter {
  chains?: string[];   // present only when the client filtered by chain
}
```

---

### `intent_created`

Broadcast to all subscribers whenever a new intent is posted via
`POST /api/v1/intents`.

```jsonc
{
  "type": "intent_created",
  "intent": { /* Intent — see Intent shape below */ },
  "seq": 43
}
```

| Field    | Type     | Description           |
|----------|----------|-----------------------|
| `intent` | `Intent` | The newly created intent |
| `seq`    | `number` | Monotonic event index |

---

### `intent_accepted`

Broadcast when a solver successfully calls `POST /api/v1/intents/:id/accept`.

```jsonc
{
  "type": "intent_accepted",
  "intentId": "3f7a1b2c-...",
  "solver": "GABC...XYZ",
  "seq": 44
}
```

| Field      | Type     | Description                          |
|------------|----------|--------------------------------------|
| `intentId` | `string` | UUID of the intent                   |
| `solver`   | `string` | Stellar public key of the solver     |
| `seq`      | `number` | Monotonic event index                |

---

### `intent_filled`

Broadcast when a solver successfully calls `POST /api/v1/intents/:id/fill`.

```jsonc
{
  "type": "intent_filled",
  "intentId": "3f7a1b2c-...",
  "solver": "GABC...XYZ",
  "fillAmount": "9950000",
  "seq": 45
}
```

| Field        | Type     | Description                                       |
|--------------|----------|---------------------------------------------------|
| `intentId`   | `string` | UUID of the intent                                |
| `solver`     | `string` | Stellar public key of the solver                  |
| `fillAmount` | `string` | Amount sent on Stellar, as a bigint-safe string   |
| `seq`        | `number` | Monotonic event index                             |

---

### `intent_cancelled`

Broadcast when the intent owner calls `POST /api/v1/intents/:id/cancel`.

```jsonc
{
  "type": "intent_cancelled",
  "intentId": "3f7a1b2c-...",
  "seq": 46
}
```

| Field      | Type     | Description           |
|------------|----------|-----------------------|
| `intentId` | `string` | UUID of the intent    |
| `seq`      | `number` | Monotonic event index |

---

### `intent_expired`

Broadcast by the background sweeper when an intent's `deadline` passes
without being filled.

```jsonc
{
  "type": "intent_expired",
  "intentId": "3f7a1b2c-...",
  "seq": 47
}
```

| Field      | Type     | Description           |
|------------|----------|-----------------------|
| `intentId` | `string` | UUID of the intent    |
| `seq`      | `number` | Monotonic event index |

---

### `replay_start`

Sent before the server begins streaming buffered events in response to a
`replay` request from the client. The server maintains a ring buffer of the
last 500 events.

```jsonc
{
  "type": "replay_start",
  "fromSeq": 38,
  "count": 9
}
```

| Field     | Type     | Description                                     |
|-----------|----------|-------------------------------------------------|
| `fromSeq` | `number` | The sequence the client requested replay from   |
| `count`   | `number` | Number of events that will be replayed          |

---

### `replay_end`

Sent after all buffered events have been streamed.

```jsonc
{
  "type": "replay_end",
  "count": 9
}
```

| Field   | Type     | Description                          |
|---------|----------|--------------------------------------|
| `count` | `number` | Number of events that were replayed  |

---

### `replay_too_old`

Sent when the client's `fromSeq` predates the oldest event in the ring buffer
(i.e. the gap is larger than 500 events). The server falls back to sending a
fresh `snapshot` automatically.

```jsonc
{
  "type": "replay_too_old",
  "fromSeq": 1,
  "oldestAvailableSeq": 320
}
```

| Field                | Type     | Description                                          |
|----------------------|----------|------------------------------------------------------|
| `fromSeq`            | `number` | The sequence the client requested                    |
| `oldestAvailableSeq` | `number` | Earliest sequence still held in the ring buffer      |

---

## Client → Server messages

### `subscribe`

Filter the event stream to a subset of source chains. Send after `connected`
or at any time to update the filter. Omit `chains` (or send an empty array)
to receive all chains.

```jsonc
{
  "type": "subscribe",
  "chains": ["ethereum", "base", "polygon"]
}
```

| Field    | Type       | Description                                        |
|----------|------------|----------------------------------------------------|
| `chains` | `string[]` | Source chains to receive. Empty = all chains.      |

The server acknowledges with a `subscribed` event.

---

### `replay`

Request a replay of all buffered events since a known sequence number.
Useful when reconnecting after a brief disconnect. Send before/instead of
waiting for the automatic snapshot on reconnect.

```jsonc
{
  "event": "replay",
  "data": { "fromSeq": 42 }
}
```

| Field            | Type     | Description                                   |
|------------------|----------|-----------------------------------------------|
| `data.fromSeq`   | `number` | Replay all events with `seq > fromSeq`        |

The server responds with `replay_start`, the buffered events, then
`replay_end`. If the gap is too large it responds with `replay_too_old`
followed by a fresh `snapshot`.

---

## Heartbeat / keepalive

The server sends a WebSocket `ping` frame every 30 seconds and closes
connections that do not respond with a `pong` within the next cycle
(effectively a 30–60 s timeout). Standard WebSocket clients handle
`ping`/`pong` automatically.

---

## Sequence numbers and gap detection

Every server-originated event carries a `seq` field that increments by 1 for
each broadcast. Clients should track the highest `seq` they have received. On
reconnect, send a `replay` message with `fromSeq = lastSeq` to recover any
events missed during the disconnect.

```
seq: 1 → 2 → 3 → … → 499 → 500 → 501 …
                           ↑ buffer wraps, oldest entry dropped
```

The ring buffer holds the last **500** events. If the gap exceeds this
the server returns `replay_too_old` and sends a fresh `snapshot` instead.

---

## Intent shape

Referenced by `snapshot.intents[]` and `intent_created.intent`.

```ts
interface Intent {
  intentId: string;          // UUID v4
  user: string;              // Stellar public key of the user
  srcChain: SupportedChain;  // "stellar" | "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "avalanche"
  srcToken: TokenInfo;
  srcAmount: string;         // bigint-safe string (wei / stroops / …)
  dstToken: StellarToken;
  minDstAmount: string;      // minimum acceptable destination amount
  quotedDstAmount?: string;  // best quote, set after POST /quote
  solver?: string;           // set once accepted
  state: IntentState;        // "open" | "accepted" | "filled" | "cancelled" | "expired" | "slashed"
  createdAt: number;         // Unix timestamp (seconds)
  deadline: number;          // Unix timestamp (seconds)
  filledAt?: number;
  fillAmount?: string;
  txHash?: string;           // Stellar transaction hash for the fill
  slashedAt?: number;
  slashReason?: string;
}

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoURI?: string;
  priceUSD?: number;
}

interface StellarToken {
  contract: string;          // Stellar contract address
  symbol: string;
  decimals: number;
  priceUSD?: number;
}
```

---

## Pending protocol extensions

The following issues will extend this protocol once merged:

- **#61 — topic subscriptions** — finer-grained filtering beyond chain
- **#62 — event sequencing** — guaranteed ordering guarantees and seq gap semantics on the server side

This document should be updated when those issues land.

---

## Quick-start example

```ts
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:4000/ws");
let lastSeq = 0;

ws.on("open", () => {
  // Optionally replay missed events if reconnecting
  if (lastSeq > 0) {
    ws.send(JSON.stringify({ event: "replay", data: { fromSeq: lastSeq } }));
  }
});

ws.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  if (typeof event.seq === "number") lastSeq = Math.max(lastSeq, event.seq);

  switch (event.type) {
    case "connected":
      // Filter to specific chains (optional)
      ws.send(JSON.stringify({ type: "subscribe", chains: ["ethereum", "base"] }));
      break;
    case "snapshot":
      console.log("open intents:", event.intents.length);
      break;
    case "intent_created":
      console.log("new intent:", event.intent.intentId);
      break;
    case "intent_filled":
      console.log("filled:", event.intentId, "amount:", event.fillAmount);
      break;
    // handle intent_accepted, intent_cancelled, intent_expired similarly
  }
});
```

For a complete reference implementation see
[`scripts/solver-bot.ts`](../scripts/solver-bot.ts).
