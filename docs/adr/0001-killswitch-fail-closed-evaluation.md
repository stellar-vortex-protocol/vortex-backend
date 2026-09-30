# ADR 0001: Fail-closed kill-switch evaluation across hierarchy levels

- **Status:** Accepted
- **Date:** 2026-09-27
- **Issue:** #477
- **Deciders:** protocol engineering

## Context

Issue #477 asks for a hierarchical emergency pause: `global` → `chain` →
`token` → `operation`. A pause at any level blocks the write it covers.

That leaves one question the issue does not answer: **what happens when a broad
switch is active and a narrower one is not?**

The tempting answer is "the most specific match wins" — pause the chain, then
resume `fill` for one token, and only that token reopens. This is how most
configuration systems behave, and it is the more flexible option.

## Decision

Evaluation is **fail-closed**: the write is blocked if **any** matching switch is
active. A narrower inactive switch does not re-open a scope a broader active
switch is holding closed.

```ts
paused: matchedChain.some((entry) => entry.active)
```

The reported reason is still the *most specific active* match, so operators and
clients see the narrowest rule actually responsible for the block.

## Rationale

The alternative is unsafe in a way that is easy to miss.

A chain-level pause exists to contain a chain-level problem: a depegged token, a
reorg, an RPC that is returning garbage. Someone responding to that incident
will naturally reach for the narrowest control that lets normal traffic resume
— "let fills through again, the issue is only this one token". Under
most-specific-wins, that single action silently re-enables the exact path the
pause was raised to contain, on a chain the operator has just declared unsafe.

Under fail-closed, the same action appears to do nothing, and the operator has
to look at why. That is the better failure: it surfaces the conflict instead of
resolving it silently in the unsafe direction.

The cost is real and we accept it — resuming a nested scope requires clearing the
broad switch first, and the runbook says so explicitly. That friction is the
feature. A resume is already a deliberate two-person action; making it slightly
more deliberate does not meaningfully slow down an emergency.

Two further properties fall out of the same rule:

- **It composes with a failed cache load.** A replica that cannot read its
  snapshot refuses writes, rather than admitting them because it has no evidence
  a pause exists. Fail-open on unknown state and fail-closed on known state are
  the same principle applied consistently.
- **It needs no timer or ordering guarantee.** Because a broad pause always
  dominates, a replica that observes a resume before the pause that preceded it
  still ends up blocked. Most-specific-wins would require replicas to observe
  updates in a consistent order, which is a much stronger property to depend on
  during an incident.

## Consequences

**Accepted costs**

- Resuming nested scopes takes more than one approval round, and the runbook must
  state the ordering. It does.
- An operator who pauses `global` and then pauses `operation` for a narrow carve
  out gets a confusing "why is this still blocked" the first time. This is the
  designed behaviour, and `GET /api/v1/ops/killswitch` returns the whole
  `matchedChain` precisely so the answer is inspectable.

**Rejected alternatives**

| Option                                          | Why not                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| Most-specific-wins                              | Silently re-opens a path a broad pause is holding closed.    |
| Timer/expiry-based auto-resume                  | An incident must not end because nobody was watching.        |
| Replica reads the DB on every write              | Puts a database round trip on the hot path of every write.   |
| Push-only (Redis) with no fallback               | A Redis outage would silently disable the emergency stop.    |

## Implementation notes

The rules live in `src/killswitch/killswitch.evaluate.ts` as pure functions — no
I/O, no clock, no DI. That is what makes the property above directly testable:
`killswitch.evaluate.spec.ts` asserts it explicitly in the case
"FAILS CLOSED: a narrower inactive switch cannot reopen a broader active pause".

Propagation uses Redis pub/sub for speed with a database `max(updated_at)` poll
as an unconditional backstop (`KILLSWITCH_POLL_MS`, default 2000 ms), so a
Redis outage degrades latency rather than disabling the control plane.
