# WebSocket protocol

The real-time intent feed is a single public, read-only WebSocket endpoint at
`/ws`. Solvers accept and fill intents over the authenticated REST API — never
over the socket.

The **machine-readable contract is [`asyncapi.yaml`](./asyncapi.yaml)**; it is
the source of truth for every frame and is served live at `GET /docs/ws`. This
document is the human-oriented guide to the same protocol (issue #456).

```bash
# Fetch the contract
curl http://localhost:4000/docs/ws

# Connect (Node)
import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:4000/ws", ["vortex.v1"]);

# Connect (browser)
const ws = new WebSocket("ws://localhost:4000/ws", ["vortex.v1"]);
```

## Version negotiation

The handshake negotiates the protocol version with the standard
`Sec-WebSocket-Protocol` header:

| Client handshake | Server behaviour |
| --- | --- |
| `Sec-WebSocket-Protocol: vortex.v1` | echoes `vortex.v1` — version 1 selected |
| header absent | accepted and treated as `vortex.v1` (documented default) |
| header lists several, `vortex.v1` among them | echoes `vortex.v1` |
| only unknown versions (e.g. `vortex.v2`) | echoes one offered token so the handshake completes, then immediately closes with code `1002` |

Notes:

* The default (no header → v1) keeps pre-#456 clients working; this is **not**
  a breaking change.
* The unknown-version case echoes an offered token purely so the handshake
  completes and the client can *observe* close code `1002`. A response without
  a subprotocol makes standard clients fail the handshake themselves and report
  `1006`, which hides the real reason.
* The `connected` frame repeats the negotiated version in its `protocol` field,
  so a client can assert what the server is actually speaking.

### Close codes

| Code | Meaning |
| --- | --- |
| `1001` | Server is shutting down — reconnect. |
| `1002` | Unsupported protocol version — reconnect offering a supported `Sec-WebSocket-Protocol`. |

## Frame flow

```
server ── connected      ──►  { type, message, seq, protocol }
server ── snapshot       ──►  { type, intents, seq }        open intents (≤ 20)
client ── subscribe      ──►  { type, chains?, all? }       per-connection filter
server ── subscribed     ──►  { type, filter }
client ── auth           ──►  { type, solver, timestamp, signature }
server ── auth_ok        ──►  { type }                      or auth_error
server ── eligible_snapshot …                              solver-scoped snapshot
server ── intent_*       ──►  broadcast events, each with a monotonic seq
client ── replay         ──►  { type, fromSeq }
server ── replay_start / intent_* … / replay_end            or replay_too_old
```

### Sequencing and replay

* Every broadcast event carries a monotonically increasing `seq`.
* A client that misses frames sends `{ "type": "replay", "fromSeq": <last seen seq> }`
  to fill the gap.
* `replay_too_old` means the gap is no longer buffered; take a fresh snapshot.
* Per-connection filters (`subscribe`) apply to the live feed **and** to
  replayed events — replay never bypasses server-side filtering.

### Server-side filters and capability scoping

* `subscribe` limits the feed to the listed chains (or everything with
  `all: true`), up to `WS_MAX_FILTER_CHAINS` chains and
  `WS_MAX_SUBSCRIPTIONS_PER_CONNECTION` subscriptions per connection.
* Authenticated solvers additionally receive only intents they are eligible
  for (`eligible_snapshot` after `auth`, then the same predicate on the live
  feed).

## Runtime validation

Outside production (`NODE_ENV !== "production"`), inbound and outbound frames
are validated against a zod mirror of the AsyncAPI schemas
(`src/ws/ws-schemas.ts`). Validation is **advisory**: a mismatch is logged
loudly (`ws frame failed schema validation` / `ws invalid …`) but never drops
or alters traffic, so it can surface spec drift without changing the wire
protocol. `src/ws/ws-schemas.spec.ts` asserts the mirror and the YAML document
cannot drift apart.

## Generated types

```bash
npm run generate:ws-types   # → src/generated/ws-api-types.ts
```

The generated unions (`WsServerFrame`, `WsClientMessage`) are committed, and
`src/scripts/ws-types-generation.spec.ts` fails if they go stale relative to
`docs/asyncapi.yaml`.

## Contract tests

`test/asyncapi-contract.e2e-spec.ts` boots the app, fetches `/docs/ws`, then
captures real frames off the wire and validates them against the served
document's JSON Schemas with ajv — including the handshake cases above.
