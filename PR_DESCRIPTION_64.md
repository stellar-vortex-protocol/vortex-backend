# PR Description: Fix Pagination NaN Bug in IntentsController.list()

## Issue Reference

- Closes #64

## Summary

`IntentsController.list()` was using `parseInt()` on raw query parameters (`limitRaw`, `offsetRaw`) without any validation. When a non-numeric value was provided (e.g., `?limit=abc`), `parseInt()` returned `NaN`, which silently corrupted the pagination slice (`intents.slice(offset, offset + limit)`) instead of returning a clear 400 error.

## Changes

### New File: `src/intents/dto/list-intents.dto.ts`

Introduced a typed DTO for list query parameters using `class-validator` decorators consistent with the rest of the codebase:

- `limit`: `@IsInt()`, `@Min(1)`, `@Max(100)` — ensures the value is a valid integer between 1 and 100
- `offset`: `@IsInt()`, `@Min(0)` — ensures the value is a valid non-negative integer
- `state`, `user`, `chain`: `@IsOptional()`, `@IsString()` — optional string filters

### Modified File: `src/intents/intents.controller.ts`

- Changed `list()` method signature from individual `@Query()` parameters to a single `@Query() dto: ListIntentsDto`
- Replaced `Math.min(parseInt(limitRaw, 10), 100)` and `parseInt(offsetRaw, 10)` with `dto.limit` and `dto.offset`
- The global `ValidationPipe` (configured in `main.ts` with `whitelist: true, transform: true`) automatically validates the DTO and returns a 400 response with detailed error information when validation fails

### Modified File: `test/intents.e2e-spec.ts`

Added two new e2e tests:

1. **`GET /api/v1/intents with non-numeric limit returns 400`** — Asserts that `?limit=abc` returns HTTP 400 with `error: "Validation failed"` and an array of `details`
2. **`GET /api/v1/intents with non-numeric offset returns 400`** — Asserts that `?offset=xyz` returns HTTP 400 with `error: "Validation failed"` and an array of `details`

## Verification

- `npm run lint` passes
- `npm run typecheck` passes
- `npm test` passes
- `npm run test:e2e` passes (new e2e tests for non-numeric limit/offset)

## Acceptance Criteria

- [x] Limit/offset moved into a proper DTO with `@IsInt()`/`@Min()`/`@Max()` validators
- [x] Non-numeric `limit` query param returns 400, not a silently broken page
- [x] Non-numeric `offset` query param returns 400, not a silently broken page
- [x] E2E tests added and passing
- [x] PR description includes "Closes #64"