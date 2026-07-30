# PR Description: Guard minDstAmount BigInt Parsing in fill()

## Issue Reference

- Closes #66

## PR Links

- PR #160: https://github.com/stellar-vortex-protocol/vortex-backend/pull/160
- Branch: `fix/min-dst-amount-defensive-parsing`

## Summary

`IntentsController.fill()` calls `BigInt(intent.minDstAmount)` directly. While `minDstAmount` is validated at creation time via `CreateIntentDto`, any future direct-DB-write path (e.g., seed data or an admin tool) could introduce a malformed value that causes an unhandled `SyntaxError` from `BigInt()`, surfacing as an ungraceful 500 instead of a clean 400.

## Changes

### Modified File: `src/intents/intents.controller.ts`

Wrapped `BigInt(intent.minDstAmount)` in a defensive try/catch that throws a `BadRequestException` with a clear data-integrity error message:

```typescript
let minAmount: bigint;
try {
  minAmount = BigInt(intent.minDstAmount);
} catch {
  throw new BadRequestException({
    error: "Data integrity error: intent minDstAmount is not a valid integer",
    intentId: id,
    minDstAmount: intent.minDstAmount,
  });
}
```

This ensures that even if a malformed `minDstAmount` exists in the database, the fill endpoint returns a structured 400 response with a clear error message rather than crashing with an unhandled exception.

### Modified File: `test/intents.e2e-spec.ts`

Added an e2e test that:
1. Creates an intent and accepts it via the API
2. Uses `IntentsService.update()` directly to corrupt the intent's `minDstAmount` to `"not-a-number"`
3. Attempts to fill the intent via the API
4. Asserts HTTP 400 with `error: "Data integrity error: intent minDstAmount is not a valid integer"`

## Verification

- `npm run lint` passes
- `npm run typecheck` passes
- `npm test` passes
- `npm run test:e2e` passes (new e2e test for malformed minDstAmount)

## Acceptance Criteria

- [x] Defensive try/catch around `BigInt(intent.minDstAmount)` in `fill()`
- [x] Clean `BadRequestException` with data-integrity error message instead of unhandled 500
- [x] E2E test added and passing
- [x] PR description includes "Closes #66"