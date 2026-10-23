-- Issue #409 — contract phase, step 1/4 (STAGED: move into prisma/migrations
-- only in the release after the backfill has been verified).
--
-- Refuses to run unless every row's timestamptz columns match the epoch
-- columns, then adds NOT NULL checks as NOT VALID (catalog-only, no scan).
-- Step 2 validates them without blocking writes; step 3 turns them into
-- real NOT NULL constraints without a scan.
-- Rollback: down.sql drops the checks.
SET LOCAL lock_timeout = '1s';

DO $$
DECLARE
    bad_intents bigint;
    bad_solvers bigint;
BEGIN
    SELECT count(*) INTO bad_intents FROM "intents"
    WHERE "created_at_ts" IS DISTINCT FROM to_timestamp("created_at")
       OR "deadline_ts"   IS DISTINCT FROM to_timestamp("deadline")
       OR "filled_at_ts"  IS DISTINCT FROM to_timestamp("filled_at");
    SELECT count(*) INTO bad_solvers FROM "solvers"
    WHERE "registered_at_ts"  IS DISTINCT FROM to_timestamp("registered_at")
       OR "last_active_at_ts" IS DISTINCT FROM to_timestamp("last_active_at");
    IF bad_intents > 0 OR bad_solvers > 0 THEN
        RAISE EXCEPTION 'epoch/timestamptz verification failed: % intents and % solvers rows out of sync', bad_intents, bad_solvers
            USING HINT = 'Run `npm run db:backfill-timestamps -- --verify`, then the backfill, before applying this migration.';
    END IF;
END $$;

ALTER TABLE "intents" ADD CONSTRAINT "intents_created_at_ts_not_null" CHECK ("created_at_ts" IS NOT NULL) NOT VALID;
ALTER TABLE "intents" ADD CONSTRAINT "intents_deadline_ts_not_null" CHECK ("deadline_ts" IS NOT NULL) NOT VALID;
ALTER TABLE "solvers" ADD CONSTRAINT "solvers_registered_at_ts_not_null" CHECK ("registered_at_ts" IS NOT NULL) NOT VALID;
ALTER TABLE "solvers" ADD CONSTRAINT "solvers_last_active_at_ts_not_null" CHECK ("last_active_at_ts" IS NOT NULL) NOT VALID;
