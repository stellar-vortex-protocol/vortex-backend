-- Issue #409 — contract phase, step 3/4 (STAGED).
-- With a validated CHECK (col IS NOT NULL) in place, SET NOT NULL skips the
-- table scan (PostgreSQL ≥ 12), so each ALTER holds ACCESS EXCLUSIVE only for
-- the catalog update. The now-redundant checks are dropped afterwards.
-- Rollback: down.sql drops NOT NULL again.
SET LOCAL lock_timeout = '1s';

-- squawk-ignore not-null-without-default
-- justification: a validated CHECK ("created_at_ts" IS NOT NULL) exists (step 2), so PostgreSQL proves the constraint without scanning; the lock is catalog-only.
ALTER TABLE "intents" ALTER COLUMN "created_at_ts" SET NOT NULL;
-- squawk-ignore not-null-without-default
-- justification: a validated CHECK ("deadline_ts" IS NOT NULL) exists (step 2), so PostgreSQL proves the constraint without scanning; the lock is catalog-only.
ALTER TABLE "intents" ALTER COLUMN "deadline_ts" SET NOT NULL;
-- squawk-ignore not-null-without-default
-- justification: a validated CHECK ("registered_at_ts" IS NOT NULL) exists (step 2), so PostgreSQL proves the constraint without scanning; the lock is catalog-only.
ALTER TABLE "solvers" ALTER COLUMN "registered_at_ts" SET NOT NULL;
-- squawk-ignore not-null-without-default
-- justification: a validated CHECK ("last_active_at_ts" IS NOT NULL) exists (step 2), so PostgreSQL proves the constraint without scanning; the lock is catalog-only.
ALTER TABLE "solvers" ALTER COLUMN "last_active_at_ts" SET NOT NULL;

ALTER TABLE "intents" DROP CONSTRAINT IF EXISTS "intents_created_at_ts_not_null";
ALTER TABLE "intents" DROP CONSTRAINT IF EXISTS "intents_deadline_ts_not_null";
ALTER TABLE "solvers" DROP CONSTRAINT IF EXISTS "solvers_registered_at_ts_not_null";
ALTER TABLE "solvers" DROP CONSTRAINT IF EXISTS "solvers_last_active_at_ts_not_null";
