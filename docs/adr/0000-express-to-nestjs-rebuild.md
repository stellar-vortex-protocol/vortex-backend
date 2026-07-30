# ADR 0000: Express to NestJS Rebuild Architecture Decision Record

- **Status**: Accepted (Implemented)
- **Date**: 2026-07-13
- **Deciders**: Engineering Team
- **Technical Story**: Rebuild legacy Express backend to NestJS framework for maintainable architecture, structured DI, rate limiting, and OpenAPI generation.

---

## Context and Problem Statement

`vortex-backend` serves as the central coordination relay for the multi-chain Vortex Protocol. Its responsibilities include:
1. Managing the intent lifecycle (create, quote, accept, fill, cancel, expire).
2. Solver registry management, reputation tracking, and bond enforcement.
3. WebSocket streaming of live intent events (`/ws`).
4. Soroban RPC contract interaction for on-chain settlement and slashing.
5. Automated background sweeper tasks for expired intents.
6. Rate limiting and request validation.

The original prototype was implemented as a monolithic, un-structured Express.js application in JavaScript/TypeScript. As features expanded:
- Express route handlers became bloated with mixed validation, business logic, and error handling.
- Adding dependency injection for repositories, services, and RPC clients required custom manual wiring.
- OpenAPI / Swagger documentation had to be written and synchronized manually, resulting in documentation rot.
- Implementing standard middleware (rate limiting, logging interceptors, input validation pipes, exception filters) was fragmented across routing files.

We needed a standardized, modular node framework to sustain rapid feature development without architectural decay.

---

## Decision Drivers

- **Maintainability & Modular Structure**: Clear separation between controllers, domain services, data access repositories, and external RPC clients.
- **Dependency Injection**: First-class DI container for easy service swapping (e.g., swapping in-memory repositories for Prisma ORM).
- **Automated OpenAPI Documentation**: Auto-generating Swagger UI docs at `/docs` directly from TypeScript DTO decorators.
- **Ecosystem & Guard Middleware**: Standardized rate-limiting (`@nestjs/throttler`), global exception filters, and request lifecycle interceptors.
- **Developer Productivity**: Standardized NestJS CLI generator tooling for modules, controllers, and services.

---

## Considered Options

1. **Option 1: Retain Express.js with custom modular architecture**
   - *Pros*: Zero migration overhead, lightweight footprint.
   - *Cons*: High ongoing maintenance effort to build and maintain custom DI containers, manual Swagger doc generation, custom rate-limiting guards, and inconsistent controller error handling.

2. **Option 2: Rebuild with NestJS framework (Selected)**
   - *Pros*: Out-of-the-box modular architecture, native TypeScript support, built-in DI container, robust ecosystem (`@nestjs/swagger`, `@nestjs/throttler`, `@nestjs/config`, `@nestjs/websockets`), standardized `ValidationPipe` using `class-validator`.
   - *Cons*: Initial migration effort to port existing routes and tests.

3. **Option 3: Rebuild with Fastify (standalone)**
   - *Pros*: Maximum raw HTTP throughput.
   - *Cons*: Lacks built-in DI structure and decorator-driven architectural patterns present in NestJS.

---

## Decision Outcome

**Chosen Option**: **Option 2: Rebuild with NestJS framework**.

### Key Architectural Implementation Details:

1. **Module Hierarchy**:
   - `AppModule` (root orchestrator, global rate limiter guard, module imports)
   - `IntentsModule` (intents API, sweeper service, WebSocket gateway)
   - `SolversModule` (solver registry, stats, reputation score engine)
   - `SorobanModule` (Soroban RPC contract client for penalty path)
   - `TokensModule` & `RoutingModule` (supported tokens & multi-chain route calculation)
   - `PrismaModule` & `ConfigModule` (database ORM abstraction & env validation)

2. **Global Exception Filter & Error Shape**:
   - Implemented a custom NestJS global exception filter to preserve backwards-compatible HTTP error response shapes for frontend and solver clients.

3. **Swagger Integration**:
   - Integrated `@nestjs/swagger` in `src/main.ts` serving interactive documentation at `GET /docs`.

---

## Consequences

### Positive Consequences
- **Code Organization**: Clean separation of concerns across `src/intents`, `src/solvers`, `src/soroban`, `src/tokens`, and `src/stats`.
- **Testability**: Unit and e2e tests can easily mock dependencies via NestJS `Test.createTestingModule()`.
- **Automatic Validation**: HTTP query/body DTOs automatically validated via `@ValidationPipe()` and `class-validator` decorators, eliminating `NaN` and type injection bugs.
- **Living API Documentation**: Interactive Swagger docs published at `/docs`.

### Negative Consequences
- Slight increase in node application boot time and initial memory footprint compared to a barebones Express server (negligible for production server deployment).
