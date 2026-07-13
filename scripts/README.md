# scripts/solver-bot.ts

Reference solver bot demonstrating the accept → fill flow against a running
`vortex-backend` instance. Connects to the `/ws` intent feed, and for every
open intent it sees (on connect via the snapshot, or live via
`intent_created`) it calls `POST /api/v1/intents/:id/accept` followed by
`POST /api/v1/intents/:id/fill`.

**Strategy is intentionally naive** — it accepts every open intent and fills
at exactly `minDstAmount`, with no profitability check, pricing, or actual
cross-chain settlement. A real solver would price the fill against live
market rates, verify the trade is profitable, execute the actual bridge/swap,
and only then call `/fill` with the real transaction hash.

## Usage

```bash
npm run dev              # in one terminal, run the backend
npm run solver:demo      # in another, run the bot
```

## Configuration (env vars)

| Var | Default | Description |
|---|---|---|
| `API_BASE` | `http://localhost:4000` | REST API base URL |
| `WS_URL` | `ws://localhost:4000/ws` | WebSocket feed URL |
| `SOLVER_ADDRESS` | `SOLVER_ALPHA` | Solver identity used for accept/fill calls — must be a registered, active solver (`SOLVER_ALPHA`/`SOLVER_BETA`/`SOLVER_GAMMA` in the seed data) |
