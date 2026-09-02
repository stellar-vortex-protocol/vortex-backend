# RFC process

This repository uses a lightweight RFC process for design changes that affect the protocol, public API, persistence model, or contract semantics. The goal is to get early feedback before a large or protocol-sensitive change becomes expensive to unwind.

## When an RFC is required

Open an RFC before implementing a change that would affect any of the following:

- `prisma/schema.prisma` enums or persisted model contracts
- `src/intents/intents.gateway.ts` WebSocket message shapes or protocol semantics
- `src/soroban/` behavior, contract assumptions, or on-chain interaction semantics
- any change that alters the public meaning of an `IntentState` or request/response payload

Minor bug fixes, cleanup, or isolated refactors do not usually require an RFC.

## Lifecycle

1. Draft: the contributor writes the proposal in `docs/rfcs/` using the template.
2. Discussion: reviewers comment on the RFC in the pull request or linked discussion.
3. Accepted: the design is approved and implementation may proceed.
4. Rejected: the design is not approved and the idea should be closed or revised.
5. Implemented: the linked pull request lands with the RFC in place.

## Worked examples

The following issue areas are examples of design work that should have an RFC before implementation begins:

- #7: routing and quote-flow changes
- #44: on-chain intent registration
- #77: pending intent lifecycle changes

## Files

- `docs/rfcs/0000-template.md` — base template for new proposals

A new RFC should be short and focused: motivation, proposed change, alternatives, and backward-compatibility impact.
