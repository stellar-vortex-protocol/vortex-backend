# Changelog

All notable changes to `vortex-backend` are documented here.

This project follows [Conventional Commits](https://www.conventionalcommits.org/)
and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.
Commit message format is enforced via [commitlint](https://commitlint.js.org/) starting with v0.2.0.

> **How to update this file**
> Run `npm run generate:client` after any API surface change and bump the version
> in `package.json`. Add your changes under `[Unreleased]` as you work; entries
> are moved to a versioned section on release.

---

## [Unreleased]

### Added
- `scripts/generate-client.ts` — generates a typed TypeScript API client from the live
  OpenAPI spec using `openapi-typescript` v7; output committed to `src/generated/`
  (Closes #134)
- `CONTRIBUTING.md` — backend-specific onboarding guide covering prerequisites,
  commands, DTO conventions, logger usage, module wiring, and PR checklist
  (Closes #135)
- `.env.testnet.example` — environment template for local testnet development with
  safe defaults and blank contract IDs (Closes #136)
- `.env.mainnet.example` — environment template for production mainnet with strict
  CORS, required signing key, and all mandatory fields marked (Closes #136)
- `commitlint.config.js` — enforces Conventional Commits via `@commitlint/config-conventional`
  (Closes #137)
- Husky `commit-msg` hook — runs commitlint on every local commit (Closes #137)
- CI job `commitlint` — validates commit messages on every push/PR in GitHub Actions
  (Closes #137)
- `src/common/amount.ts` — shared, unit-tested base-units ↔ decimal conversion plus
  the protocol fee (0.05 %) and quote-variance helpers; `IntentsController.quote()`
  and `fill()` now use it instead of duplicated inline `BigInt`/decimal math
  (Closes #272)
- `PATCH /api/v1/solvers/:address` (`UpdateSolverDto`, `buildUpdateSolverMessage`) —
  signature-verified partial update of a solver's mutable profile fields
  (`name`, `supportedChains`, `supportedTokens`, `avgFillTime`); immutable fields
  are stripped by the DTO whitelist (Closes #273)
- Typed Swagger response documentation for every `SorobanController` and
  `TokensController` route, including the account route's 400/429 responses
  (Closes #271)

### Fixed
- `IntentsService.create()` idempotency-key handling is now race-safe — concurrent
  requests carrying the same key synchronously claim an in-flight slot before any
  `await`, so exactly one intent is created and the losers replay its result
  (Closes #274)
- `TokensModule` was missing `exports: [TokensService]` — `IntentsController`
  could not inject `TokensService` outside the Jest test environment
- `IntentsModule` was missing `exports: [IntentsGateway]` — `StatsService`
  could not inject `IntentsGateway` outside the Jest test environment

---

## [0.1.0] — 2026-07-01

Initial versioned release of the NestJS rewrite.

### Added (features)
- Full NestJS rebuild replacing the original Express server
- `ConfigModule` with Joi-based env validation and production signing-key enforcement
- `GET/POST /api/v1/intents` — intent listing, creation, accept, fill, cancel, quote
- `GET /api/v1/solvers` — solver leaderboard and stats
- `GET /api/v1/tokens` — supported token registry with chain filtering
- `GET /api/v1/stats` — protocol-level statistics
- `GET /health` — service health with database and Soroban RPC checks
- `WS /ws` — real-time intent feed with snapshot on connect and event replay buffer
- `GET /docs` — Swagger / OpenAPI UI (spec available at `/docs-json`)
- `GET /api/v1/chain/*` — Soroban RPC read endpoints (health, ledger, network, account)
- Soroban transaction signer service with fee estimation and retry/backoff
- Soroban contract event ingestion service
- Settlement contract integration for on-chain intent registration
- Solver registry contract integration (solver registry, deregistration, liveness)
- Routing service with address validation and price oracle integration
- Ed25519 signature verification on cancel/accept/fill/register endpoints
- Per-user intent rate limiting (10 creates / 60 s) on top of global IP throttle
- Idempotency key support on `POST /api/v1/intents`
- Intent expiry sweeper (30 s interval, configurable)
- WebSocket heartbeat and dead-client cleanup
- Topic-based filtering for WS subscriptions
- WS subscriber count cap (configurable via `WS_MAX_CONNECTIONS`)
- Request ID correlation across HTTP logs and error responses
- Structured Winston logging with configurable log level
- Prometheus metrics endpoint (`/metrics`)
- OpenTelemetry tracing instrumentation
- Sentry error alerting integration
- Helmet HTTP security headers with Swagger-compatible CSP
- Global CORS enforcement (wildcard rejected in `NODE_ENV=production`)
- 10 KB body size limit on all routes
- Append-only intent audit log
- Prisma ORM with PostgreSQL schema and migration tooling
- Reference solver bot (`npm run solver:demo`) with exponential reconnect backoff
- Seed script (`npm run seed`)
- Database backup/restore runbook (`RUNBOOK_BACKUP_RESTORE.md`)
- Load tests for concurrent intent accept race conditions and WS broadcast fanout
- Full unit and e2e test suite (coverage threshold: 70 % on all axes)

### Fixed
- Precision loss in quote calculation for large bigint amounts
- `fillAmount` format validation before `BigInt` parsing
- `limit`/`offset` query param validation on intent listing
- `minDstAmount` `BigInt` parsing guard in `fill()`
- CORS wildcard default replaced with strict origin validation
- Log injection vectors sanitised

### Security
- CORS wildcard (`*`) rejected at startup in `NODE_ENV=production`
- Ed25519 Stellar signature authentication on all state-mutating endpoints
- `SOROBAN_SIGNING_KEY` validated against Stellar secret seed format at startup
  in production; process refuses to start without a well-formed key
- Secrets scanning via Gitleaks in CI
- `npm audit` at `--audit-level=high` in CI
- WS connection limit to prevent resource exhaustion

---

[Unreleased]: https://github.com/vortex-protocol/vortex-backend/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vortex-protocol/vortex-backend/releases/tag/v0.1.0
