# CI performance

Timings for the [CI workflow](../.github/workflows/ci.yml), maintained as part of
issue #486 ("CI Performance Overhaul: Sharding, Caching, and Flaky-Test
Quarantine").

Everything under **Measured** comes from the GitHub Actions API, not from
estimates. Anything computed by hand is under **Computed** and says so.

## Measured: state of the pipeline before this change

Sample: the last 60 runs of the `CI` workflow on `main` and on feature branches,
collected 2026-09-28.

| Metric | Value |
|---|---|
| Runs inspected | 60 |
| Runs that created any job | 42 |
| Runs that created **zero** jobs | 18 (the 3 most recent are the parse bug below; the older ones predate it) |
| Backend jobs that reached the `Unit tests` step | **0** |

Two independent faults had to be fixed before any wall-clock number could mean
anything:

1. **The workflow file did not parse.** On `main`, `jobs.backend` had `runs-on`
   appended to the `name:` line, so the job had no runner and GitHub rejected
   the whole file. The symptom is silent and easy to misread: the run appears in
   the Actions UI, is marked red in 0 seconds, and contains **no jobs at all**
   (`gh run view <id>` reports *"This run likely failed because of a workflow
   file issue"*). Within this sample it accounts for the three most recent runs —
   every run since 2026-09-26 16:03 UTC — and it is why `main` currently has no
   CI at all.
2. **The backend job never reached the tests.** Of the 42 runs that did create
   jobs, the longest median `Backend (Nest) – Node 20` job is **0.8 min**,
   because it fails in one of the first three steps. Blocking steps, counted
   across those runs:

   | Step | Failures |
   |---|---|
   | `Check env var drift` | 29 |
   | `Install dependencies` (`npm ci`) | 21 |
   | `Type-check` | 16 |
   | `Generate Prisma client` | 2 |

   `Check env var drift` was the leading cause: `main` carried 19 inconsistencies
   between `env.validation.ts`, `configuration.ts` and the four
   `.env*.example` files. Two more blockers sat behind it — `soroban.module.ts`
   on `main` called `forwardRef(() => IntentsModule)` without importing either
   symbol, so the project did not type-check at all, and `npm ci` failed
   outright in 21 backend jobs. All three are fixed on this branch, so the first
   honest "after" number can finally be taken.

Because no run ever executed the test phase, **there is no measured baseline for
the test wall time itself.** Quoting one would be inventing it. The before/after
comparison therefore starts from the first run on this branch that completes
`coverage`.

## Computed: the critical path

A structural comparison, not a measurement. `npm ci` dominates every job, so
serialising four of them behind one another is the cost being removed.

**Before** — one `backend` job per Node version, tests last:

```
node-version x { env-drift -> prisma -> migrate -> lint -> typecheck -> build -> UNIT -> E2E }
                                                          critical path = the whole chain, x2
```

**After** — static checks stay in `backend`; tests fan out and merge:

```
backend   (node 20, 22)          env-drift -> prisma -> migrate -> lint -> typecheck -> build
   |
   +-> unit-tests  1..4/4        in parallel
   +-> e2e-tests   1..2/2        in parallel
          |
          +-> coverage          merge 4 shard reports, enforce the 70% gate
```

The test phase goes from *serial on two runners* to *sharded across six runners
plus a merge*, and the unit and e2e suites stop waiting for lint and build to
finish on the other Node version. Caching (`node_modules/.prisma`, `dist/`) takes
a further `npm`-independent chunk out of every job.

## Measuring the "after"

Wall clock is the sum of the run's job durations, not the number of jobs — a
pipeline that is 3x more parallel but takes the same time has not improved. Take
the median of at least three consecutive runs on this branch, after the caches
are warm:

```bash
# Wall clock and the two job that define the critical path, per run.
gh run list --workflow ci.yml --branch <branch> --limit 5 \
  --json databaseId,createdAt,updatedAt

# Per-job durations for one run.
gh api repos/stellar-vortex-protocol/vortex-backend/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | {name, conclusion, started_at, completed_at}'
```

Then fill in the table and state the result against the acceptance criterion:

| | Before | After | Change |
|---|---|---|---|
| Run wall clock (median of 3+) | not measurable — see above | _fill in_ | _fill in_ |
| `unit-tests` phase, serial | _never ran_ | _fill in_ | _fill in_ |
| E2E phase, serial | _never ran_ | _fill in_ | _fill in_ |
| Longest single job | 0.8 min (`Backend (Nest) – Node 20`) | _fill in_ | _fill in_ |

The target is **≥ 50 % lower wall clock**. If a run is still blocked in
`Check env var drift`, `Install dependencies` or `Type-check`, that run is not
comparable: fix the blocker first, then measure. Caching also makes the first
run after a cache expiry look slower than steady state, which is why the median
of three is the number to quote.

## Keeping the numbers honest

- The required check name `Backend (Nest) – Node 20` uses an **en dash**
  (U+2013), not a hyphen. Branch protection matches that string exactly, so
  "tidying" the dash renames a required check and blocks every PR. Same for the
  `unit-tests`/`e2e-tests` shard names, which contain a `/` in the matrix
  expression — they render as `Unit tests (shard 1/4)`.
- Changing a shard count means changing `--expect-shards` in the `coverage` job
  in the same commit; the merge job fails loudly rather than gating on a partial
  union.
- `fail-fast: false` on both test matrices is load-bearing. With it on, the
  first red shard cancels its siblings, their coverage artifacts are never
  uploaded, and the merge job reports "a shard never wrote its report" instead
  of the failure that actually happened.
