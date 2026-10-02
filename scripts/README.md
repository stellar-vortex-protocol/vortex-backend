# scripts/solver-bot.ts

Reference solver bot demonstrating the full accept → fill flow against a running `vortex-backend` instance.

> **Production Solver Operators**: For the complete production guide on solver registration, bond deposits, cryptographic authentication, and slashing policies, see [docs/solver-onboarding.md](file:///home/yahia008/rasputin/vortex-backend/docs/solver-onboarding.md).

---

## Overview & Authentication

`scripts/solver-bot.ts` connects to the `/ws` intent feed, subscribes to configured chain topics, and for every open intent it receives:
1. Constructs the canonical message `accept:<intentId>:<solverAddress>` and signs it using Stellar Ed25519 keypair authentication.
2. Calls `POST /api/v1/intents/:id/accept` with the signed message.
3. Constructs the canonical message `fill:<intentId>:<solverAddress>` and signs it.
4. Calls `POST /api/v1/intents/:id/fill` with `fillAmount` and transaction hash.

**Strategy is intentionally naive** — it accepts every open intent and fills at exactly `minDstAmount`, with no profitability check, pricing, or actual cross-chain settlement. A real solver would price the fill against live market rates, verify the trade is profitable, execute the actual bridge/swap, and only then call `/fill` with the real transaction hash.

---

## Topic Subscriptions & Reconnection Behavior

- **Chain Subscriptions**: After connecting to the WebSocket feed, the bot sends `{ type: "subscribe", chains: [...] }` to receive intent notifications only for supported chains.
- **Sequence Replay**: On reconnect, the bot requests event replay from its last received sequence ID (`seq`), ensuring zero dropped intents during transient disconnects.
- **Backoff & Shutdown**: Reconnects automatically on disconnect with exponential backoff (1s → 2s → 4s → … → 30s max). Handles `SIGINT`/`SIGTERM` for graceful shutdown.

---

## Usage

```bash
npm run dev              # in one terminal, run the backend
npm run solver:demo      # in another, run the bot
```

---

## Configuration (env vars)

| Var | Default | Description |
|---|---|---|
| `API_BASE` | `http://localhost:4000` | REST API base URL |
| `WS_URL` | `ws://localhost:4000/ws` | WebSocket feed URL |
| `SOLVER_ADDRESS` | `SOLVER_ALPHA` | Solver identity used for accept/fill calls — must be a registered, active solver (`SOLVER_ALPHA`/`SOLVER_BETA`/`SOLVER_GAMMA` in the seed data) |
| `SOLVER_CHAINS` | `stellar,ethereum,base,polygon,arbitrum,optimism,avalanche` | Comma-separated list of chain topics to filter WebSocket intent events |
| `MIN_MARGIN_BPS` | `0` | Minimum margin threshold in basis points for filtering unviable intent fills |

The bot's accept gate (state → deadline → chain → margin) is shared with
the simulation harness below — see `tools/simulator/strategies/gate.ts`.

---

# tools/simulator

Solver simulation & backtesting harness (issue #452). Replays an archived
intent stream against pluggable solver strategies on a **deterministic
simulated clock** — no network, no Nest bootstrap, no wall-clock reads —
and reports **PnL, fill-rate and slash-risk**, optionally across a
fill-window × fee-bps parameter sweep.

The harness reuses the pure domain modules directly:

- `src/fees` — `quoteFee` prices every fill under the configured fee bps
- `src/routing` — `RoutingService.buildRoute` gates settlement feasibility
- `src/auctions` — `dutchAuctionPrice` drives auction-aware fills

`npm run typecheck`/`npm run lint` cover it the usual way; the harness's
suite runs in the unit test project `tools` (`tools/simulator/*.spec.ts`).

## Usage

```bash
# Replay an archive with the default margin-aware strategy
npm run simulate -- --input tools/simulator/fixtures/sample-intents.jsonl \
  --prices tools/simulator/fixtures/sample-prices.jsonl

# Baseline: the naive accept-everything strategy (same gate as scripts/solver-bot.ts)
npm run simulate -- --input archive.jsonl --prices prices.jsonl --strategy always

# Comparative sweep: fill window × fee bps → markdown table
npm run simulate -- --input archive.jsonl --prices prices.jsonl --sweep \
  --fill-windows 60,120,300 --fee-bps-list 0,5,10

# Smoke-run without data (deterministic synthetic archive) + raw report dump
npm run simulate -- --generate 100000 --strategy always --json report.json

# Full option list
npm run simulate -- --help
```

## Data format

Archived intents are **JSON Lines**, one event per line. Field names
mirror the public `intents` dataset schema (`src/datasets/schemas.ts`), so
exported dataset rows replay with minimal reshaping:

| Field | Type | Required | Notes |
|---|---|---|---|
| `intentId` | string | ✔ | |
| `createdAt`, `deadline` | int (unix s) | ✔ | `createdAt` positions the simulated clock |
| `srcChain`, `srcAmount`, `minDstAmount` | string | ✔ | amounts in base units |
| `srcTokenSymbol`, `dstTokenSymbol` | string | | enables USD valuation |
| `usdValueAtCreate` | number | | source-leg value captured at creation; preferred over price lookups |
| `auction` | object | | `{ startDstAmount, decayStart, decayEnd }` Dutch auction |
| `event` | `"intent"` \| `"quote_request"` | | dispatch selector (default `intent`) |

Prices are JSONL snapshots `{"ts","chain","symbol","priceUsd","decimals?"}`;
lookups resolve to the latest snapshot at or before the simulated time.
**Unknown prices are never guessed** — fills with unpriceable legs are
counted but excluded from USD totals (reported as `unpriced fills`).

Blank lines and `#` comments are ignored in both formats.

## Strategies & the strategy interface

Implement `SimulatorStrategy` (`tools/simulator/types.ts`):

```ts
interface SimulatorStrategy {
  readonly name: string;
  onIntent(ctx, intent): QuoteDecision | null;       // new intent on the feed
  onQuoteRequest(ctx, intent): QuoteDecision | null; // RFQ round
  onTick(ctx, nowSec): void;                         // clock advanced
}
```

Returning `null` declines; returning `{ dstAmount, fillDelayMs? }`
schedules a fill at `now + fillDelayMs`, which the engine checks against
the intent deadline and the fill-window parameter. `ctx.random()` is a
seeded PRNG, so even randomized strategies replay identically per seed.

Two reference strategies ship with the harness:

| Strategy | Behaviour |
|---|---|
| `always` (`AlwaysFillStrategy`) | quotes `minDstAmount` immediately for every gate-passing intent — the exact strategy `scripts/solver-bot.ts` runs live, extracted for offline replay |
| `margin` (`MarginThresholdStrategy`, default) | values both legs via archived prices, quotes the protocol fee, checks routing feasibility, and optionally waits for Dutch-auction decay (`--auction`) before filling |

## Sweep mode

`--sweep` replays the same archive once per grid cell
(`--fill-windows` × `--fee-bps-list`, defaults `60,120,300` × `0,5,10`)
and prints one comparative markdown row per cell: fill rate, capture,
slashes, PnL, fees, volume. `--json` dumps the full structured sweep.

## Determinism & performance

The engine consumes only archive timestamps (never `Date.now()`), and all
randomness flows through the seeded PRNG — so identical
(archive, prices, strategy, params, seed) inputs yield byte-identical
reports. This is asserted by the determinism tests in
`tools/simulator/engine.spec.ts`, and `tools/simulator/perf.spec.ts`
enforces the issue's budget: **1M intents replay in under 5 minutes**.

---

# scripts/backfill-events.ts

CLI script for historical event backfill after ledger gaps (#391).

See [docs/runbooks/event-backfill.md](../docs/runbooks/event-backfill.md) for the full procedure.

## Usage

```bash
# Check for gaps
tsx scripts/backfill-events.ts --gap-check

# Dry-run over a ledger range
tsx scripts/backfill-events.ts --from 1000000 --to 1015000 --dry-run

# Backfill (with optional resume on restart)
tsx scripts/backfill-events.ts --from 1000000 --to 1015000 [--resume]
```

## Configuration (env vars)

| Var | Required | Description |
|---|---|---|
| `SETTLEMENT_CONTRACT_ID` | Yes | Contract to backfill events for |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SOROBAN_RPC_URL` | Yes | Primary RPC endpoint |
| `ARCHIVAL_RPC_URL` | No | Archival endpoint for deep-history gaps |

## Fixture Regeneration

Golden-file fixtures in `src/soroban/events/__fixtures__/events.json` document
the expected decoded payload for each event topic. To regenerate from real
testnet events:

1. Point `SOROBAN_RPC_URL` + `SETTLEMENT_CONTRACT_ID` at a testnet deployment.
2. Run the backfill with `VERBOSE=1 --dry-run` over a small ledger range.
3. Copy the printed decoded event data into `__fixtures__/events.json`.
4. Update `expectedPayload` fields to match your schema expectations.
5. Commit the updated fixture file.

The decoder unit tests in `src/soroban/events/*.spec.ts` load this file
automatically — no test code changes needed when fixtures are refreshed.
