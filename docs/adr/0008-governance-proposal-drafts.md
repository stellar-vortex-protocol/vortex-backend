# ADR 0008 — Governance Parameter-Change Proposal Drafts

**Status:** Accepted  
**Date:** 2026-10-25  
**Issue:** #507-params

---

## Context

Protocol parameters (fee, deadlines, slash amount, exposure ratio) are governed
on-chain via the Soroban governance contract. `ProtocolParamsService` mirrors
them reactively: it only learns of a proposed value *after* someone has already
spent a transaction submitting it. The first time the backend sees a malformed
proposal is after it is already on-chain.

There is also no place for operators to draft and review a parameter change
before committing to the transaction cost and latency of an on-chain submission.

---

## Decision

Introduce a **backend-side staging area** for parameter-change proposals:

1. **`GovernanceProposalDraft` Prisma model** — stores proposed params (JSON),
   status (`draft` | `validated` | `submitted` | `rejected`), the creating
   admin's id, an optional description, and structured validation errors.

2. **`ProtocolParamsService.validateProposedParams()`** — a single,
   shared validation method that checks every supplied field against
   `PARAM_BOUNDS` and returns *all* violations as structured data. It never
   throws and never rejects outright so an operator sees every problem at once.

3. **Three admin-gated REST endpoints** on `ParamsController`:
   - `POST /api/v1/params/proposals` — create a draft; validation runs at
     creation time and status is set to `validated` (clean) or `draft` (errors).
   - `GET /api/v1/params/proposals` — list drafts, optionally filtered by status.
   - `PATCH /api/v1/params/proposals/:id/status` — advance status manually:
     `validated` (re-runs validation), `submitted` (operator marks on-chain tx
     sent), `rejected`.

4. **Out of scope for this ADR**: building, signing, or submitting the on-chain
   governance transaction. That remains a manual, out-of-band action using
   existing tooling.

---

## Consequences

### Positive

- Operators can draft and inspect all validation violations before spending a
  transaction.
- Validation logic lives in exactly one place (`validateProposedParams`), shared
  with any future simulate endpoint, eliminating the risk of divergent
  bounds-checking.
- The `submitted` status provides a lightweight audit trail of when operators
  acknowledged sending the on-chain transaction.
- The `rejected` status lets operators formally close a draft without submitting,
  keeping the queue tidy.

### Negative / Trade-offs

- **In-memory only** during on-chain submission: once the actual governance
  transaction is submitted out-of-band, there is no automatic linkage back to
  the draft row. The operator must call `PATCH .../status` manually.
- Drafts are never automatically expired; a future sweep job may be needed if
  the table grows large.

### Neutral

- The `GovernanceProposalDraft` model does not replace or interact with the live
  `ProtocolParams` data path. Drafts are purely advisory until submitted on-chain.

---

## Alternatives Considered

**Re-implement bounds-checking in the controller** — rejected; would create a
third copy of the validation logic (service, simulate, controller) that could
silently diverge.

**Reject the draft outright on first validation error** — rejected per spec;
operators need to see all violations at once to fix them efficiently.

**Auto-submit the on-chain transaction from the backend** — out of scope for
this issue; requires governance key management and signing infrastructure that
does not exist yet.
