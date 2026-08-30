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
