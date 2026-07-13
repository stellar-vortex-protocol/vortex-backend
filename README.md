# vortex-backend

**Intent relay API + WebSocket feed for [Vortex Protocol](https://github.com/vortex-protocol).**

[![CI](https://github.com/vortex-protocol/vortex-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/vortex-protocol/vortex-backend/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

TypeScript / [NestJS](https://nestjs.com) service that brokers swap intents
between users and the solver network and streams the live intent feed. Part
of the multi-repo Vortex stack — see also
[`vortex-contract`](https://github.com/vortex-protocol/vortex-contract) and
[`vortex-frontend`](https://github.com/vortex-protocol/vortex-frontend).

> The relay currently uses an in-memory store and mock data. On-chain
> integration (Soroban RPC reads/writes) is on the roadmap.

> **Rebuild in progress:** the service was just re-scaffolded on NestJS. The
> endpoints below describe the target API surface; they're being ported back
> in module by module (see the Roadmap section), so not all of them are live
> yet.

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
```

---

## Local Development

### Prerequisites

- Node.js 20+

```bash
npm install
cp .env.example .env
npm run dev    # http://localhost:4000
```

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | Watch-mode Nest server (`nest start --watch`) |
| `npm run build` | Build the Nest app (`dist/`) |
| `npm run start` | Run compiled server (`dist/main.js`) |
| `npm run lint` | ESLint over `src` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Run the test suite |

---

## Roadmap

- [ ] **On-chain integration** — replace the in-memory store with Soroban RPC reads/writes
- [ ] **Solver WS client** — reference implementation for a solver bot

---

## Contributing

See the org-wide
[CONTRIBUTING.md](https://github.com/vortex-protocol/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2025 Vortex Protocol Contributors
