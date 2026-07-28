# PR Description: Guard BigInt(dto.fillAmount) Against Malformed Input

## Issue Reference

- Closes #65

## PR Links

- PR #159: https://github.com/stellar-vortex-protocol/vortex-backend/pull/159
- Branch: `fix/fill-amount-validation`

## Summary

`IntentsController.fill()` calls `BigInt(dto.fillAmount)` directly. While `FillIntentDto` already has `@Matches(/^\d+$/)` on `fillAmount` (matching the pattern used on `CreateIntentDto.srcAmount`), there was no e2e test asserting that a non-numeric `fillAmount` returns a clean 400 validation error instead of an ungraceful 500 `SyntaxError` from `BigInt()`.

## Changes

### Modified File: `test/intents.e2e-spec.ts`

Added a new e2e test:

**`POST /api/v1/intents/:id/fill with non-numeric fillAmount returns 400`**

- Creates an intent and accepts it with a valid solver
- Submits a fill request with `fillAmount: "abc"` (non-numeric)
- Asserts HTTP 400 response with `error: "Validation failed"` and an array of `details`
- Confirms the response is a clean validation error, not an ungraceful 500 from `BigInt("abc")` throwing a `SyntaxError`

## Background

The `FillIntentDto` already includes the `@Matches(/^\d+$/)` decorator on `fillAmount`, which ensures only digit-only strings reach the `BigInt()` constructor. The `ValidationPipe` (configured globally in `main.ts` with `whitelist: true, transform: true`) intercepts invalid input before it reaches the controller method and returns a structured 400 response.

This test closes the gap by verifying the end-to-end behavior: a malformed `fillAmount` query body is rejected at the validation layer with a clear 400 status.

## Verification

- `npm run lint` passes
- `npm run typecheck` passes
- `npm test` passes
- `npm run test:e2e` passes (new e2e test for non-numeric fillAmount)

## Acceptance Criteria

- [x] `FillIntentDto.fillAmount` has `@Matches(/^\d+$/)` pattern matching `CreateIntentDto.srcAmount`
- [x] E2E test added asserting non-numeric `fillAmount` returns 400 with validation error, not 500
- [x] PR description includes "Closes #65"