# Contributing to vortex-backend

> This document covers **backend-specific** setup and conventions.
> For the process, code of conduct, and org-wide guidelines, see the
> [org-wide CONTRIBUTING.md](https://github.com/vortex-protocol/.github/blob/main/CONTRIBUTING.md).

Closes #135

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Getting started](#getting-started)
3. [Development workflow](#development-workflow)
4. [Running the test suite](#running-the-test-suite)
5. [Code conventions](#code-conventions)
6. [Module and file structure](#module-and-file-structure)
7. [Adding a new endpoint](#adding-a-new-endpoint)
8. [Environment variables](#environment-variables)
9. [Regenerating the API client SDK](#regenerating-the-api-client-sdk)
10. [Commit messages](#commit-messages)
11. [Submitting a pull request](#submitting-a-pull-request)

---

## Prerequisites

| Tool | Minimum version | Notes |
|------|----------------|-------|
| Node.js | 20 | Use [nvm](https://github.com/nvm-sh/nvm) to pin the version |
| npm | 10 | Bundled with Node 20 |
| Docker (optional) | any | Only needed for a local Postgres instance |

No global installs are required — all tooling is in `devDependencies`.

---

## Getting started

```bash
# 1. Clone and install
git clone https://github.com/vortex-protocol/vortex-backend.git
cd vortex-backend
npm install

# 2. Set up environment — pick the variant that matches your target network
cp .env.testnet.example .env   # for testnet development (most common)
# cp .env.mainnet.example .env # for mainnet — requires real keys and contract IDs

# 3. Start the dev server (watch mode, no DB required for most features)
npm run dev
# → http://localhost:4000
# → Swagger UI: http://localhost:4000/docs
# → WebSocket: ws://localhost:4000/ws
```

> Most feature work does not require Postgres — the service uses an in-memory
> store by default. `DATABASE_URL` has a sensible default so the app boots
> without a live database. You only need Postgres if you are working on
> Prisma migrations or the database-backed health check.

---

## Development workflow

| Command | Description |
|---------|-------------|
| `npm run dev` | Watch-mode NestJS server (restarts on save) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled server (`dist/main.js`) |
| `npm run lint` | ESLint across `src/`, `test/`, `scripts/` |
| `npm run typecheck` | `tsc --noEmit` — no output files, just type errors |
| `npm run test` | Unit tests (Jest) |
| `npm run test:e2e` | End-to-end tests against a booted app (supertest) |
| `npm run generate:client` | Regenerate the typed API client in `src/generated/` |
| `npm run solver:demo` | Run the reference solver bot (see [`scripts/README.md`](./scripts/README.md)) |
| `npm run seed` | Seed the database with sample data |
| `npm run db:migrate` | Run pending Prisma migrations against the local DB |

Run the full verification suite before opening a PR:

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
```

---

## Running the test suite

### Unit tests

```bash
npm test                    # run all unit tests
npm test -- --watch         # watch mode
npm test -- --coverage      # with coverage report (threshold: 70 % on all axes)
```

Unit test files live next to the source file they test (`*.spec.ts`). Mocks
for external dependencies go in `test/__mocks__/`.

### End-to-end tests

```bash
npm run test:e2e
```

E2E tests use `supertest` against a real (but in-process) NestJS application.
The `createTestApp()` helper in `test/utils/create-test-app.ts` boots the full
`AppModule` with a no-op `PrismaService` stub so no live database is required.

The `@stellar/stellar-sdk` is mocked globally in e2e tests via Jest's
`moduleNameMapper` (see `test/jest-e2e.json`) so Soroban calls never hit
the network.

---

## Code conventions

### DTO validation

Every request body is typed with a **DTO class** decorated with
`class-validator` decorators and documented with `@nestjs/swagger` decorators:

```typescript
import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExampleDto {
  @ApiProperty({ description: 'A Stellar contract address (56 uppercase chars)' })
  @IsString()
  @Matches(/^[A-Z0-9]{56}$/)
  contractId!: string;
}
```

Rules:
- All DTO fields must be **explicitly decorated** — no plain TypeScript types.
- Use `@ApiProperty` / `@ApiPropertyOptional` on every field for Swagger.
- Optional fields use `@IsOptional()` + `@ApiPropertyOptional()` and are typed
  with `?:` (not `| undefined`).
- Amount fields are `string` (bigint-as-string) with a `@Matches(/^\d+$/)` guard.
- Custom validators live in `src/common/validators/`.

### Logger

Use the shared Winston logger from `src/common/logger.ts` — do **not** create
per-service logger instances with `new Logger()` (NestJS built-in) in code
paths outside NestJS lifecycle hooks:

```typescript
import { logger } from '../common/logger';

logger.info('intent created', { intentId, user });
logger.warn('deadline approaching', { intentId, secondsLeft });
logger.error('fill failed', { intentId, error: err.message });
```

Use `Logger` from `@nestjs/common` only in NestJS-specific lifecycle methods
(`onModuleInit`, `onModuleDestroy`) where the shared instance may not yet be
bootstrapped.

### Error handling

Throw NestJS HTTP exceptions from controllers — never `throw new Error(...)`:

```typescript
import { NotFoundException, ConflictException } from '@nestjs/common';

if (!intent) throw new NotFoundException('Intent not found');
if (intent.state !== 'open') throw new ConflictException(`Intent is ${intent.state}`);
```

The global `HttpExceptionFilter` in `src/common/http-exception.filter.ts`
serialises all exceptions into a consistent `{ statusCode, message, error }`
JSON response.

### Module wiring

Every NestJS module must explicitly **export** any provider that other modules
depend on. Do not rely on the DI container resolving cross-module providers
without a proper `exports` declaration:

```typescript
@Module({
  providers: [MyService],
  exports: [MyService],   // ← required if any other module injects MyService
})
export class MyModule {}
```

---

## Module and file structure

```
src/
  <domain>/
    <domain>.module.ts          # NestJS module definition
    <domain>.controller.ts      # HTTP routes + Swagger annotations
    <domain>.service.ts         # Business logic
    <domain>.service.spec.ts    # Unit tests for the service
    <domain>.repository.ts      # Repository interface + DI token + in-memory adapter
    prisma-<domain>.repository.ts  # Prisma adapter (when persistence is needed)
    dto/                        # Request/response DTOs
  common/                       # Shared utilities (logger, filters, guards)
  config/                       # ConfigModule + Joi validation schema
  prisma/                       # PrismaService (database client wrapper)
  generated/                    # Auto-generated API types (do not edit)
scripts/                        # Developer scripts (run via tsx)
test/                           # E2E tests and shared helpers
```

### Repository pattern

Every domain module that owns persistent state follows the same injectable-
repository pattern modelled after `SolversModule`:

1. **`<domain>.repository.ts`** exports:
   - A `Symbol` DI token (`INTENTS_REPOSITORY`, `SOLVERS_REPOSITORY`, …).
   - A TypeScript `interface` (`IIntentsRepository`, `ISolversRepository`, …).
   - The **in-memory adapter** (`InMemoryIntentsRepository`, …) as the
     default implementation.

2. **`prisma-<domain>.repository.ts`** exports the Prisma-backed adapter
   (`PrismaIntentsRepository`, `PrismaSolversRepository`, …).

3. **`<domain>.module.ts`** binds the token to an adapter via a `useFactory`
   provider that reads an env var (`INTENTS_PERSISTENCE`, `SOLVERS_PERSISTENCE`)
   and returns the appropriate instance.  Nothing else in the codebase needs
   to change when switching adapters.

The services (`IntentsService`, `SolversService`) inject the token and always
`await` repository method calls so both sync (in-memory) and async (Prisma)
shapes work transparently:

```typescript
@Injectable()
export class IntentsService {
  constructor(
    @Inject(INTENTS_REPOSITORY)
    private readonly repo: IIntentsRepository,
    // ...
  ) {}

  async get(id: string): Promise<Intent | undefined> {
    return this.repo.findById(id);   // works for both adapters
  }
}
```

To add a **new domain** with repository-backed persistence:

1. Create `<domain>.repository.ts` with the Symbol, interface, and in-memory adapter.
2. Create `prisma-<domain>.repository.ts` with the Prisma adapter.
3. Bind the token in `<domain>.module.ts` using the env-var-driven `useFactory` pattern.
4. Inject the token into the service with `@Inject(YOUR_REPOSITORY_TOKEN)`.
5. Add the new `*_PERSISTENCE` variable to `src/config/env.validation.ts`.

**Never** import a concrete repository class directly into a service — always
use the DI token so the adapter remains swappable.

---

## Adding a new endpoint

1. **Define the DTO** in `src/<domain>/dto/` with class-validator + Swagger decorators.
2. **Add the service method** in `src/<domain>/<domain>.service.ts`.
3. **Add the controller route** in `src/<domain>/<domain>.controller.ts` with
   Swagger response decorators (`@ApiOkResponse`, `@ApiNotFoundResponse`, etc.).
4. **Write unit tests** for the service method alongside the service file.
5. **Write an e2e test** in `test/<domain>.e2e-spec.ts` (or extend an existing one).
6. **Regenerate the SDK**: run `npm run generate:client` and commit the updated
   `src/generated/` files.

---

## Environment variables

Three `.env.example` variants are provided:

| File | Use case |
|------|----------|
| `.env.example` | Generic template with all available variables |
| `.env.testnet.example` | Testnet development (RPC, blank contract IDs, relaxed CORS) |
| `.env.mainnet.example` | Production mainnet (strict CORS, required signing key) |

Copy the right one for your context and fill in real values where marked.
**Never commit a filled-in `.env` file.**

The validation schema in `src/config/env.validation.ts` documents every
variable with Joi — run `npm run dev` and check the startup error if any
variable fails validation.

---

## Regenerating the API client SDK

Whenever you add, remove, or rename an endpoint or change a DTO, regenerate
the typed client so downstream consumers stay in sync:

```bash
npm run generate:client
```

This builds the app first (`npm run build`), boots a throw-away NestJS process
to collect Swagger metadata, and writes three files to `src/generated/`:

- `openapi.json` — raw OpenAPI 3.0 spec (useful for Postman / Redoc)
- `api-types.ts` — TypeScript types for all paths, operations, and schemas
- `index.ts` — re-export entry point

Commit these files as part of the same PR that changes the API surface.

---

## Commit messages

This repo enforces the [Conventional Commits](https://www.conventionalcommits.org/)
format via commitlint:

```
<type>(<optional scope>): <short summary>

# Types: feat | fix | docs | style | refactor | test | chore | perf | ci | build
```

Examples:

```
feat(intents): add idempotency key support to POST /intents
fix(solvers): return 403 when bond is zero instead of 500
docs: add backend-specific CONTRIBUTING guide
test(intents): cover expired-deadline path in e2e suite
chore: regenerate API client SDK after adding quote endpoint
```

The CI job `commitlint` checks the PR title on every pull request. Squash
merges are preferred so that the merge commit title is the canonical changelog
entry.

---

## Submitting a pull request

1. Fork the repo and create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes, following the conventions above.
3. Run the full verification suite:
   ```bash
   npm run lint && npm run typecheck && npm test && npm run test:e2e
   ```
4. Open a PR against `main` with:
   - A clear description of **what** changed and **why**.
   - `Closes #<issue-number>` in the description body.
   - Test output or screenshots demonstrating the fix.
5. Address review comments and keep the branch rebased on `main`.

PRs that fail lint, typecheck, or any test will not be merged.
