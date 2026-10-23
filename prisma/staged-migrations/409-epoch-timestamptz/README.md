# Staged: epoch → timestamptz contract phase (issue #409)

These migrations are **not applied by `prisma migrate deploy`** yet. They make
the timestamptz columns mandatory and drop the epoch INTEGER columns, so
they ship in a later release, after:

1. phase 1 (expand + indexes) is deployed everywhere,
2. `npm run db:backfill-timestamps -- --verify` reports `0 row(s) out of sync`
   for both tables, and
3. `TIMESTAMP_READ_SOURCE=timestamptz` has run in production without issues.

See `prisma/migrations/README.md` → "Expand/contract: epoch → timestamptz"
for the whole procedure.

## Steps

| Directory | Effect | Locks |
|-----------|--------|-------|
| `20261101000000_epoch_ts_not_null_checks` | Verification guard, then `CHECK (… IS NOT NULL) NOT VALID` | catalog-only |
| `20261101000001_epoch_ts_validate_checks` | `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE` (reads/writes continue) |
| `20261101000002_epoch_ts_set_not_null` | `SET NOT NULL` (proved by the checks), drop the checks | catalog-only |
| `20261101000003_epoch_ts_contract` | Verification guard, drop the sync triggers and the Int columns | catalog-only |

Steps 1–3 can ship in one release. Step 4 must ship **together with** the
application change below, because the Prisma client of the previous release
still writes the Int columns.

## Releasing

1. Rename each directory to a current timestamp and move it into
   `prisma/migrations/`. Keep the order.
2. In `prisma/schema.prisma`:
   - remove `createdAt`, `deadline`, `filledAt` (Intent) and `registeredAt`,
     `lastActiveAt` (Solver) along with the indexes that use them;
   - make `createdAtTs`, `deadlineTs`, `registeredAtTs`, `lastActiveAtTs`
     required (`DateTime`); `filledAtTs` stays optional.
3. In `src/intents/prisma-intents.repository.ts`,
   `src/solvers/prisma-solvers.repository.ts` and
   `src/archival/archival.service.ts`, drop the epoch branches. Read and
   write only the `*Ts` fields and keep converting to epoch seconds at the
   mapping layer, so API payloads do not change.
4. Remove `TIMESTAMP_READ_SOURCE` from `src/config/*` and the `.env*.example`
   files.
5. `npm run check:migrations` lints the moved files; the `-- squawk-ignore`
   in step 3 carries its justification.

## Rollback

- Steps 1–3: run the step's `down.sql`.
- Step 4: run its `down.sql`. It re-adds the Int columns (nullable) and the
  sync triggers. Then:
  ```bash
  npm run db:backfill-timestamps -- --direction to-epoch --fresh
  npm run db:backfill-timestamps -- --verify
  ```
  Rebuild the nine Int indexes with `CREATE INDEX CONCURRENTLY` (definitions
  in `20260828000001_composite_partial_indexes`,
  `20260929000000_api_credentials_intent_search`,
  `20260929000002_intent_src_verification` and
  `20261001000000_token_fk_normalization`), then restore `NOT NULL` on
  `created_at`, `deadline`, `registered_at` and `last_active_at` with the same
  check → validate → set pattern as steps 1–3. Finally redeploy the release
  that still has the Int fields.
