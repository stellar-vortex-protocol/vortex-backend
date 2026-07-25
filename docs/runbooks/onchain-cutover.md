# Runbook: Cutting Over From In-Memory State to On-Chain-Backed State

## Status

**This runbook describes the planned cutover procedure, not a completed
migration.** As of this writing, `IntentsService` and `SolversService` are
backed entirely by in-process `Map`s (see `src/intents/intents.service.ts`,
`src/solvers/solvers.service.ts`). Soroban RPC access is currently
**read-only** (`SorobanService`, `/api/v1/chain/*`).

Landing an on-chain-backed cutover in a live environment requires all of the
following to ship first — this runbook is not actionable until they do, and
should be reviewed/updated as each lands:

| Dependency | What it provides | Status |
|---|---|---|
| Signing-key config (this repo) | Validated `SOROBAN_SIGNING_KEY` for the backend's own Soroban signer | Landing alongside this runbook |
| Signer strategy (issue #21) | Actual transaction-building/signing/submission code path | Open |
| On-chain intent registration (issue #22) | Replaces in-memory `create()` with a real Soroban tx | Open |
| Solver-registry wiring (issue #23) | `accept()` calls the solver-registry contract | Open |
| On-chain fill settlement (issue #24) | `fill()` submits + confirms a settlement tx | Open |
| Dry-run mode (issue #35) | Config flag to simulate on-chain writes without submitting | Open |
| Intent audit trail (issue #62) | Append-only log of every state transition, independent of the state store | Open |

Treat the checklist below as the gate for actually running this procedure:
do not attempt a live cutover until every dependency above is merged, has
its own passing tests, and has been exercised on testnet.

## Overview

Today, the source of truth for intent and solver state is process memory.
Restarting the service, or losing the pod, loses all state. The cutover
replaces the in-memory `Map`s with the Soroban settlement and
solver-registry contracts as the source of truth, with the in-memory store
becoming a read cache (or being removed entirely, depending on how issue
#22/#24 land).

The risk this runbook exists to manage: **the switch from
"authoritative in-memory state" to "authoritative on-chain state" is a
single moment where in-flight intents (state `open` or `accepted`) could be
read inconsistently, double-processed, or silently dropped** if the cutover
isn't staged and reversible.

## Pre-checks

Run through all of these before scheduling a cutover window, and re-verify
immediately before flipping traffic:

1. **Dependencies merged and soaked.** Every row in the Status table above
   is merged to `main`, deployed to staging, and has run against Soroban
   testnet for at least 48h with no unexplained errors.
2. **Dry-run soak clean.** The dry-run flag (issue #35) has been enabled in
   the target environment for at least one full sweeper cycle window
   (several multiples of the 30s `IntentsSweeperService` interval, but in
   practice run it for hours, not seconds) with zero simulation failures
   logged. Every code path that would submit a transaction — intent
   registration, fill settlement, solver-registry slashing — must have been
   exercised in dry-run at least once.
3. **Signing key provisioned correctly.** `SOROBAN_SIGNING_KEY` is set to a
   real, funded key in the target environment's secrets manager (never in
   plaintext env files), `NODE_ENV=production` validation
   (`src/config/env.validation.ts`) passes, and the corresponding public
   key has sufficient XLM for fees plus a safety margin.
4. **Contract IDs confirmed.** `SETTLEMENT_CONTRACT_ID` and
   `SOLVER_REGISTRY_CONTRACT_ID` point at the intended network's deployed
   contracts (cross-check against `STELLAR_NETWORK` — a mainnet key against
   a testnet contract ID, or vice versa, is a classic cutover mistake).
5. **Audit trail live and independently queryable.** Issue #62's audit log
   is writing for every transition on the current in-memory path *before*
   cutover, so there is continuity of history across the switch rather than
   a gap starting from zero.
6. **In-flight intent census.** Immediately before the window, snapshot
   `GET /api/v1/intents?state=open` and `?state=accepted` (or the
   equivalent internal read) and record the full list. This is the
   reconciliation baseline — every one of these intents must be accounted
   for after cutover, either resolved (filled/expired/cancelled) or
   present in the new on-chain-backed store.
7. **Rollback path rehearsed.** The rollback procedure below has been
   executed at least once against a staging environment with synthetic
   in-flight intents, not just read from this document for the first time
   during an incident.
8. **Alerting wired.** Whoever is on call has dashboards/alerts for
   Soroban RPC error rate, transaction submission failures, and sweeper
   duration (the sweeper now does chain I/O per cycle instead of pure
   in-memory work — its latency profile changes materially).

## Dry-run flag and the cutover

The dry-run flag (issue #35) is the primary safety mechanism this runbook
leans on. It's a config-level switch (default **on** outside production,
per that issue's requirements) that makes every on-chain-write code path
build and simulate a Soroban transaction, log what *would* be submitted,
and return without broadcasting it.

How it factors into cutover staging:

1. **Stage 1 — dry-run in target environment.** Deploy the on-chain code
   paths with the dry-run flag forced on, traffic unchanged (reads/writes
   still served from the in-memory store). This validates that transaction
   construction, contract ID wiring, and the signing key all work, with
   zero funds-moving risk. This is pre-check #2 above.
2. **Stage 2 — shadow writes.** Flip dry-run off for a canary slice (or a
   single non-critical path, e.g. solver-registry reads before slashing
   writes) while the in-memory store remains authoritative for reads. Watch
   for transaction failures, unexpected fees, or confirmation-latency
   surprises.
3. **Stage 3 — cutover.** Flip the in-memory store from authoritative to
   cache (or remove it, per how #22/#24 implement this) for the full
   read/write path. Dry-run stays off. This is the point of no return for
   this procedure — from here, rollback means the explicit procedure below,
   not just re-flipping a flag.

Keep the dry-run flag itself deployed (not ripped out) after cutover — it's
the fastest lever if a related on-chain code path needs to be redeployed or
patched later without another full staged rollout.

## Rollback plan

The goal: **return to in-memory-authoritative state with zero data loss for
any intent that was `open` or `accepted` at the moment of rollback.**

Rollback triggers (any one is sufficient to invoke this procedure):

- Transaction failure rate above baseline for on-chain writes.
- Sweeper cycle time regresses badly enough to risk missing expiry/slash
  windows.
- Audit trail (#62) shows a state transition that has no corresponding
  on-chain confirmation, or vice versa (a mismatch is worse than either
  system being briefly behind).
- Any evidence of an in-flight intent being processed twice (e.g. filled
  in-memory and also settled on-chain, or slashed on-chain but still shown
  `accepted` in a read path).

Procedure:

1. **Freeze new writes.** Flip a kill switch (reuse the dry-run flag,
   forced on, or a dedicated `read-only` mode if one exists by the time
   this runs) so no new intents are created/accepted/filled/slashed
   on-chain while rollback is in progress. This is why dry-run must ship as
   a runtime-toggleable config value, not a build-time constant.
2. **Reconcile in-flight intents from the chain back into memory.** For
   every intent in the pre-cutover census (pre-check #6) that is still
   `open` or `accepted`:
   - Read its current state from the settlement contract (the same
     read-only `SorobanService` methods used today, e.g.
     `getAccount`/ledger queries, plus whatever read methods #22/#24 add).
   - Reconstruct the in-memory `Intent` record from that on-chain state —
     `state`, `solver`, `deadline`, `fillAmount`/`txHash` if present — so
     the fields the sweeper and controller depend on
     (`src/intents/intents.types.ts`) are populated correctly rather than
     defaulted.
   - Cross-check the reconstructed record against the audit trail (#62):
     the last logged transition for that intent must be consistent with
     the on-chain state you just read. A mismatch here means don't guess —
     escalate and resolve manually before continuing, since it indicates
     the two systems disagree about history.
3. **Re-seed the in-memory store.** Load every reconciled record into
   `IntentsService`/`SolversService` before re-enabling the in-memory code
   path, so there's no window where a read returns "not found" for an
   intent that genuinely exists.
4. **Flip traffic back to in-memory-authoritative.** Revert the read/write
   path (config flag or deploy of the pre-cutover build, whichever the
   actual #22/#24 implementation supports) so `IntentsController` reads
   from and writes to the in-memory store again.
5. **Leave on-chain state alone — don't try to unwind it.** Anything
   already confirmed on-chain (a fill, a slash) stays confirmed; rollback
   moves the *source of truth* back to memory, it does not reverse
   settled transactions. The in-memory record for that intent must reflect
   the final on-chain outcome (step 2), not a pre-chain state.
6. **Verify against the census.** Confirm every intent from the pre-cutover
   census (pre-check #6) is present in the in-memory store with a state
   that's either unchanged or a legitimate progression (e.g. `accepted` →
   `filled`), and that the audit trail has no gap across the rollback
   boundary.
7. **Post-incident: diff and publish.** Compare the audit trail's record of
   what happened during the on-chain window against what the in-memory
   store now shows, and publish the diff (even if empty) so reviewers can
   confirm no history was silently dropped — this is the concrete
   requirement issue #62 exists to satisfy for this runbook.

## Coordination with the audit trail (issue #62)

This runbook depends on #62 landing *before* cutover, not after, because:

- Pre-check #5 and rollback step 2's cross-check both require the audit
  trail to already be recording transitions during the in-memory period —
  there's no way to retroactively backfill "what happened" once a rollback
  is underway.
- Rollback step 7 (the post-incident diff) is only meaningful if the audit
  trail's coverage started before the cutover window, giving a continuous
  record spanning pre-cutover → on-chain → rollback.
- The whole point of this runbook's "no data loss for in-flight intents"
  requirement is unenforceable without an independent record to reconcile
  against — the in-memory store and the chain can each individually claim
  to be right, and only the audit trail can say which one actually matches
  what happened over time.

## Open questions to resolve before this runbook is actionable

- Exact mechanism for "in-memory store as cache vs. removed" — depends on
  how #22/#24 are implemented; update the rollback procedure's step 3/4
  once that's decided, since "re-seed the cache" and "redeploy the old
  code" are different operational procedures.
- Whether the kill switch in rollback step 1 is the same config value as
  the dry-run flag (#35) or a separate one — recommend reusing dry-run to
  avoid a second flag with overlapping semantics, but that's a call for
  whoever implements #35.
