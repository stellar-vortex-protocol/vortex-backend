# vortex-backend

**Intent relay API + WebSocket feed for [Vortex Protocol](https://github.com/vortex-protocol).**

[![CI](https://github.com/vortex-protocol/vortex-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/vortex-protocol/vortex-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

TypeScript / [NestJS](https://nestjs.com) service that brokers swap intents
between users and the solver network and streams the live intent feed. Part
of the multi-repo Vortex stack — see also
[`vortex-contract`](https://github.com/vortex-protocol/vortex-contract) and
[`vortex-frontend`](https://github.com/vortex-protocol/vortex-frontend).

> The relay currently uses an in-memory store and mock data. Read-only
> Soroban RPC access is live (`/api/v1/chain/*`); writing intent state
> on-chain is still on the roadmap.

> **Rebuild complete:** the service has been ported from Express to NestJS.
> All endpoints below are live.

---

## API Endpoints

```
GET  /api/v1/intents              — list intents (filter by state, user, chain)
GET  /api/v1/intents/open         — all open intents (solver view)
GET  /api/v1/intents/:id          — single intent
GET  /api/v1/intents/user/:addr   — intents for a user
POST /api/v1/intents              — create intent
POST /api/v1/intents/:id/accept   — solver accepts
POST /api/v1/intents/:id/fill     — solver fills
POST /api/v1/intents/:id/cancel   — user cancels
POST /api/v1/intents/quote        — get best quote from solvers
GET  /api/v1/solvers              — solver leaderboard
GET  /api/v1/solvers/:addr/stats  — solver performance stats
GET  /api/v1/tokens               — supported tokens (filter by chain)
GET  /api/v1/stats                — protocol stats
GET  /health                      — service health
WS   /ws                          — real-time intent feed
GET  /docs                        — Swagger / OpenAPI docs
GET  /api/v1/chain/health         — Soroban RPC health (read-only)
GET  /api/v1/chain/ledger         — latest Soroban ledger
GET  /api/v1/chain/network        — Soroban network info
GET  /api/v1/chain/account/:key   — Stellar account lookup
```

---

## Local Development

### Prerequisites

- Node.js 20+

```bash
npm install
cp .env.testnet.example .env   # testnet development (most contributors)
# cp .env.mainnet.example .env # production/mainnet — requires real keys
npm run dev    # http://localhost:4000
```

Three `.env.example` variants are provided for different deployment targets:

| File | Use case |
|------|----------|
| `.env.example` | Generic template with all available variables |
| `.env.testnet.example` | Testnet development — safe defaults, blank contract IDs |
| `.env.mainnet.example` | Production mainnet — strict CORS, required signing key and contract IDs |

### Signing key

`SOROBAN_SIGNING_KEY` holds the secret key the backend uses to submit its own
on-chain writes (settlement, slashing). It's optional in development/test —
leave it blank and those code paths simply have nothing to sign with — but
**required and format-validated in production** (`NODE_ENV=production`); the
process refuses to start without a well-formed Stellar secret seed rather
than falling back to any placeholder.

For local dev, generate a throwaway **testnet-only** keypair — never reuse a
mainnet or otherwise real key:

```bash
npx @stellar/stellar-cli keys generate local-dev --network testnet
npx @stellar/stellar-cli keys show local-dev        # paste into SOROBAN_SIGNING_KEY

# or, ad hoc:
node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())"

# fund it via Friendbot before using it against testnet:
curl "https://friendbot.stellar.org/?addr=<PUBLIC_KEY>"
```

Never commit a filled-in `.env`, and never point a real/funded key at
anything but `mainnet` with `NODE_ENV=production` behind a proper secrets
manager.

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | Watch-mode Nest server (`nest start --watch`) |
| `npm run build` | Build the Nest app (`dist/`) |
| `npm run start` | Run compiled server (`dist/main.js`) |
| `npm run lint` | ESLint over `src` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Run the unit test suite |
| `npm run test:e2e` | Run the e2e test suite (supertest against a real booted app) |
| `npm run solver:demo` | Run the reference solver bot ([`scripts/README.md`](./scripts/README.md)) |

---

## Docker

```bash
docker build -t vortex-backend .
docker run -p 4000:4000 vortex-backend
```

No `.env` is required to boot — `ConfigModule`'s validation schema supplies
defaults for every variable. Pass real values with `--env-file .env` or `-e`
flags to override them.

---

## Supported chains

`SupportedChain` in `src/intents/intents.types.ts` lists seven chains.
The table below clarifies which are **live** (real integration exists today)
versus **planned** (schema/token data in place, on-chain settlement pending).

| Chain | Status | Notes |
|-------|--------|-------|
| **Stellar** | ✅ Live | Soroban RPC reads (`/api/v1/chain/*`), signing service, settlement design in progress |
| Ethereum | 🔲 Planned | Token registry populated; on-chain integration not yet implemented |
| Base | 🔲 Planned | Token registry populated; on-chain integration not yet implemented |
| Polygon | 🔲 Planned | Token registry populated; on-chain integration not yet implemented |
| Arbitrum | 🔲 Planned | Token registry populated; on-chain integration not yet implemented |
| Optimism | 🔲 Planned | Token registry populated; on-chain integration not yet implemented |
| Avalanche | 🔲 Planned | Token registry populated; on-chain integration not yet implemented |

> **Contributor note:** EVM chains are accepted in the intent DTO and stored
> in-memory, but no on-chain settlement or bridging logic is wired up yet.
> See [`docs/architecture/onchain-settlement.md`](./docs/architecture/onchain-settlement.md)
> for the target design.

---

## Roadmap

- [x] **Soroban RPC reads** — health/ledger/network/account lookups via `/api/v1/chain/*`
- [ ] **On-chain writes** — replace the in-memory intent store with real Soroban transactions (target design: [`docs/architecture/onchain-settlement.md`](./docs/architecture/onchain-settlement.md))
- [x] **Solver WS client** — reference implementation for a solver bot (`npm run solver:demo`, see [`scripts/README.md`](./scripts/README.md))

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for backend-specific setup, conventions, and
the PR checklist. It links to the org-wide guide for process and code of conduct.

## License

[MIT](./LICENSE) © 2025 Vortex Protocol Contributors
