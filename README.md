# vortex-backend

**Intent relay API + WebSocket feed for [Vortex Protocol](https://github.com/vortex-protocol).**

[![CI](https://github.com/vortex-protocol/vortex-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/vortex-protocol/vortex-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

TypeScript / [NestJS](https://nestjs.com) service that brokers swap intents
between users and the solver network and streams the live intent feed. Part
of the multi-repo Vortex stack — see also
[`vortex-contract`](https://github.com/vortex-protocol/vortex-contract) and
[`vortex-frontend`](https://github.com/vortex-protocol/vortex-frontend).

> Intents persist to Postgres in production (`INTENTS_STORE=postgres`); local
> development defaults to an in-memory store seeded with mock data. Read-only
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
POST /api/v1/intents              — create intent (oracle-checked minDstAmount; 201 includes fairValue + slippageBps)
POST /api/v1/intents/:id/accept   — solver accepts
POST /api/v1/intents/:id/fill     — solver fills
POST /api/v1/intents/:id/cancel   — user cancels
POST /api/v1/intents/quote        — get best quote from solvers
GET  /api/v1/solvers              — solver leaderboard
GET  /api/v1/solvers/:addr/stats  — solver performance stats
GET  /api/v1/tokens               — supported tokens (filter by chain)
POST /api/v1/admin/tokens         — register a token (admin key, on-chain metadata check)
PATCH /api/v1/admin/tokens        — update status or re-verified metadata
DELETE /api/v1/admin/tokens       — soft-delist a token (existing intents keep working)
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
- Docker (optional, for the one-command local Postgres + app dev stack)

```bash
npm install
cp .env.testnet.example .env   # testnet development (most contributors)
# cp .env.mainnet.example .env # production/mainnet — requires real keys
npm run dev    # http://localhost:4000
```

### One-command local stack with Postgres

If you need the Prisma-backed local database flow, use the repo-provided compose stack:

```bash
docker compose up --build
```

This starts:
- a `postgres:16-alpine` service matching the CI credentials (`vortex` / `vortex` / `vortex`)
- the app service built from the existing Dockerfile
- the app already pointed at `DATABASE_URL=postgresql://vortex:vortex@postgres:5432/vortex?schema=public`

After the stack is up, the backend is available at http://localhost:4000 and the DB is reachable using the same default credentials shown in `.env.example`.

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

### Production deployment

The table below separates variables that **must** be set for a real deployment
from those that are safe to leave at their testnet/dev defaults.

| Variable | Required for production | Safe default? | Notes |
|---|---|---|---|
| `NODE_ENV` | Yes — set to `production` | No | Enables signing-key validation and strict startup checks |
| `DATABASE_URL` | Yes | No | Must point to a managed Postgres instance, not `localhost` |
| `CORS_ORIGIN` | Yes | No | Must be an explicit origin (e.g. `https://app.vortex.trade`), never `*` |
| `SOROBAN_SIGNING_KEY` | Yes (once on-chain writes land) | No | Required and format-validated in `production`; process refuses to start without a valid Stellar secret seed |
| `SETTLEMENT_CONTRACT_ID` | Yes (on-chain path) | No | 56-char Stellar contract ID of the deployed settlement contract |
| `SOLVER_REGISTRY_CONTRACT_ID` | Yes (on-chain path) | No | 56-char Stellar contract ID of the deployed solver-registry contract |
| `STELLAR_NETWORK` | Yes | No | Set to `mainnet`; default is `testnet` |
| `SOROBAN_RPC_URL` | Yes | No | A production-grade Soroban RPC endpoint; the default points at the public testnet |
| `INTENTS_STORE` | Yes — set to `postgres` | `memory` | `memory` loses all intents on restart and cannot scale horizontally. Promote via `dual` per [`docs/runbooks/intents-store-migration.md`](./docs/runbooks/intents-store-migration.md). `INTENTS_PERSISTENCE=prisma` is a deprecated alias for `postgres` |
| `SOLVERS_PERSISTENCE` | Recommended | `memory` | Set to `prisma` to persist solver registry to Postgres; `memory` loses solver state on restart |
| `EVM_DEPOSIT_VERIFICATION_ENABLED` | Yes — set to `true` | `false` | EVM-source intents are hidden from solvers until the escrow deposit is confirmed; needs `EVM_RPC_URLS` and `EVM_ESCROW_ADDRESSES`. See [`docs/runbooks/evm-deposit-verification.md`](./docs/runbooks/evm-deposit-verification.md) |
| `SOROBAN_FEE_PERCENTILE` | Recommended | `p50` | Raise to `p90` on mainnet for better confirmation speed under load |
| `WS_MAX_CONNECTIONS` | Recommended | `1000` | Tune to expected solver + frontend connection count |
| `SENTRY_DSN` | Recommended | — (Sentry disabled) | Set to your Sentry project DSN for error alerting |
| `LOG_LEVEL` | Recommended | `debug` | Set to `info` in production — `debug` is too noisy |
| `LEADER_ELECTION_ENABLED` | Recommended (multi-replica) | `false` | Set to `true` when running N > 1 replicas to ensure singleton workers run on exactly one pod. Requires `DATABASE_URL` to point at a live Postgres instance. **Do not use PgBouncer in transaction-pooling mode** — see [Leader Election runbook](./docs/runbooks/leader-election.md). |
| `LEADER_ELECTION_HEARTBEAT_MS` | Optional | `5000` | Heartbeat interval in ms. Lower = faster failover, higher DB load. Default gives ≤ 15 s failover. |
| `PORT` | Optional | `4000` | Change if the container port mapping differs |
| `MAX_USER_SLIPPAGE_BPS` | Optional | `100` | Max user slippage vs oracle fair `minDstAmount` (1% default). Higher slippage requires a signed `acknowledgeHighSlippage`. |
| `MAX_PREMIUM_BPS` | Optional | `50` | Max `minDstAmount` premium above oracle fair value; always rejected above this. |
| `ORACLE_FAIL_OPEN_MAX_USD` | Optional | `100` | When oracle prices are missing/stale, intents with source notional at or below this USD amount are still created. |
| `ORACLE_MAX_STALENESS_MS` | Optional | `60000` | Price snapshots older than this are treated as unavailable. |

For a production `.env` template, copy `.env.mainnet.example` — every
`<CHANGE_ME>` value corresponds to a "required for production" row above.
Store secrets (`SOROBAN_SIGNING_KEY`, `DATABASE_URL`) in a secrets manager
(AWS Secrets Manager, HashiCorp Vault, etc.) and inject them at runtime;
never commit filled-in values to version control.

### Verified security headers

The Nest app boots with Helmet enabled and explicitly configures HSTS for HTTPS
origins. The backend also trusts a single proxy hop (`app.set("trust proxy", 1)`) so a TLS-terminating
load balancer can pass through `X-Forwarded-Proto: https` and allow Helmet/HSTS to
emit `Strict-Transport-Security` rather than silently skipping it behind a proxy.

The HTTP response set is verified in the e2e suite to include Helmet defaults such as
`X-Content-Type-Options: nosniff` alongside the configured HSTS policy. This is the
baseline transport-security posture the service relies on in production.

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

> **Contributor note:** EVM chains are accepted in the intent DTO. With
> `EVM_DEPOSIT_VERIFICATION_ENABLED=true` the backend confirms the user's
> escrow deposit (`src/chains/evm/`) before the intent is offered to solvers;
> no settlement or bridging logic is wired up yet.
> See [`docs/architecture/onchain-settlement.md`](./docs/architecture/onchain-settlement.md)
> for the target design.

---

## Roadmap

- [x] **Soroban RPC reads** — health/ledger/network/account lookups via `/api/v1/chain/*`
- [x] **Durable intent store** — intents persist to Postgres (`INTENTS_STORE=postgres`) with atomic SQL transitions, optimistic concurrency (`ETag` / `If-Match`) and cross-replica idempotency; migration via a dual-write phase ([runbook](./docs/runbooks/intents-store-migration.md))
- [ ] **On-chain writes** — back intent state transitions with real Soroban transactions (target design: [`docs/architecture/onchain-settlement.md`](./docs/architecture/onchain-settlement.md))
- [x] **Solver WS client** — reference implementation for a solver bot (`npm run solver:demo`, see [`scripts/README.md`](./scripts/README.md))

---

## Performance Testing (k6)

The repo ships a [k6](https://grafana.com/docs/k6/latest/) performance suite
that gates PRs against latency and error-rate budgets. Results are posted
automatically as a PR comment and uploaded as CI artifacts.

### Scenarios

| Scenario | File | What it exercises |
|----------|------|--------------------|
| `create-intent-burst` | `scenarios/create-intent-burst.js` | POST `/api/v1/intents` burst (20 VUs, 80 s) |
| `solver-polling` | `scenarios/solver-polling.js` | GET `/api/v1/intents/open` polling (10 VUs, 60 s) |
| `quote-requests` | `scenarios/quote-requests.js` | POST `/api/v1/intents/quote` ramping arrival rate |
| `mixed-lifecycle` | `scenarios/mixed-lifecycle.js` | Full read/write cycle (create → poll → read → quote → stats) |

All four run concurrently via `test/perf/k6/all-scenarios.js` in CI.

### Baseline budgets

Budgets live in `test/perf/k6/baselines/all-scenarios.json`. PRs that regress
any metric beyond **+15% of baseline** fail the `k6-perf` job.

| Metric | p95 budget | p99 budget |
|--------|-----------|-----------|
| `http_req_duration` (all) | 500 ms | 1000 ms |
| `POST /intents` | 200 ms | 400 ms |
| `GET /intents/open` | 150 ms | 300 ms |
| `POST /intents/quote` | 200 ms | 500 ms |
| Full lifecycle cycle | 600 ms | — |
| Read-only endpoints | 150 ms | — |
| Global error rate | < 1% | — |

### Running locally

Prerequisites: [k6 installed](https://grafana.com/docs/k6/latest/get-started/installation/)
and the server running (`npm run dev`).

```bash
# Run all four scenarios (CI entry point)
npm run perf

# Run a single scenario
npm run perf:create-intent
npm run perf:solver-polling
npm run perf:quote-requests
npm run perf:mixed-lifecycle

# Compare the latest run against baselines
npm run perf:compare

# Update baselines after a known-good run on main
npm run perf:update-baselines

# Regenerate pre-computed Ed25519 fixture signatures
npm run perf:gen-fixtures
```

### Noise control

The CI workflow runs k6 **three times** and uses the last run's summary.
The +15% tolerance band absorbs run-to-run variation on the fixed-size
GitHub Actions runner. Baselines are automatically updated on `main` pushes,
so the reference point always tracks the current head.

### Updating budgets

Edit the `thresholds` section in
`test/perf/k6/baselines/all-scenarios.json`.  Do not edit `reference` — that
section is overwritten automatically by `npm run perf:update-baselines`.

---

## Preview environments

Every same-repo PR can be deployed to an isolated, seeded preview environment
(API, Swagger at `/docs`, WebSocket at `/ws`) by adding the **`preview`** label;
it is torn down on close, on label removal, or after a TTL. See
[docs/ci/preview-environments.md](./docs/ci/preview-environments.md) for the
trigger rules, cost cap and required repository configuration. Previews are
testnet-only with throwaway keys — forked PRs are excluded.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for backend-specific setup, conventions,
and the PR checklist. For community expectations and governance, see
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) and
[docs/rfcs/README.md](./docs/rfcs/README.md).

## License

[MIT](./LICENSE) © 2025 Vortex Protocol Contributors
