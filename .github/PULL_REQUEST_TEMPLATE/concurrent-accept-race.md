# Load-test the persistence layer for concurrent accept/fill races

## Summary

This PR adds a race-condition load test for concurrent `accept()` and `fill()` calls on the same intent, and fixes the underlying non-atomic read-check-update pattern in `IntentsController` by introducing atomic conditional-update methods in `IntentsService`.

## Problem

The current `IntentsController.accept()` and `IntentsController.fill()` follow a **read → check → update** pattern:

```ts
const intent = this.intentsService.get(id);          // Read
if (intent.state !== "open") throw new Conflict();   // Check
this.intentsService.update(id, { state: "accepted" }); // Write
```

This is safe in a single-threaded Node.js process with no `await` between steps, but once state lives in a shared database across multiple backend instances (horizontal scaling), this pattern breaks — two instances could both read `"open"` state and both succeed in accepting the same intent.

## Solution

### 1. Atomic conditional-update methods (`src/intents/intents.service.ts`)

Added `acceptIfOpen()` and `fillIfAccepted()` — synchronous, atomic check-and-update methods that mirror the DB pattern:

```sql
-- acceptIfOpen
UPDATE intents SET state='accepted', solver=$1, deadline=now+300
WHERE id=$2 AND state='open'
RETURNING *

-- fillIfAccepted
UPDATE intents SET state='filled', fillAmount=$1, txHash=$2, filledAt=$3
WHERE id=$4 AND state='accepted' AND solver=$5
RETURNING *
```

Both return `null` when the preconditions are not met (intent not found, wrong state, wrong solver).

### 2. Controller refactored (`src/intents/intents.controller.ts`)

Updated `accept()` and `fill()` to use the atomic methods instead of the separate `get → check → update` pattern. Error handling now checks the return value of the atomic method.

### 3. Load test (`test/load/concurrent-accept.test.ts`)

- **HTTP-level tests**: Fires 20 concurrent `accept()` (or `fill()`) requests at the same intent via supertest, asserts exactly one succeeds (201) and the rest fail (409 Conflict)
- **Unit-level tests**: Calls `acceptIfOpen()` / `fillIfAccepted()` 50 times synchronously on the same intent, asserts exactly one winner
- **Multi-intent test**: Races different solvers for different intents concurrently, verifies all resolve correctly

### 4. E2e config fixes (`test/jest-e2e.json`)

Fixed pre-existing issues that prevented e2e tests from running:
- Disabled ts-jest diagnostics for missing type declarations (`@types/joi`, `@stellar/stellar-sdk`)
- Added moduleNameMapper mock for `@stellar/stellar-sdk` (ESM-only package incompatible with Jest's CJS resolver)
- Extended test regex to include load test files

## Test Results

```
Unit tests:  26 passed (3 suites)
E2e tests:   23 passed (5 suites)
Load tests:   5 passed (1 suite)
Total:       54 tests passing
```

## Migration Path

When moving to a real database, replace `acceptIfOpen()` and `fillIfAccepted()` with parameterized SQL using `WHERE state = '...'` clauses. The in-memory implementation already guarantees atomicity and serves as the reference contract.

## Checklist

- [x] Load test runs concurrent accept() calls for the same intent
- [x] Asserts only one wins
- [x] DB-level conditional update pattern (atomic methods)
- [x] Unit tests for atomic methods
- [x] `npm run lint` passes
- [x] `npm run typecheck` passes
- [x] `npm test` passes
- [x] `npm run test:e2e` passes

Closes #63
