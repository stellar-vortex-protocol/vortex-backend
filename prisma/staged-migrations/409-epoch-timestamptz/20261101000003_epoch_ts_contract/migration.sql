-- Issue #409 — contract phase, step 4/4 (STAGED). Ship together with the
-- schema.prisma change that removes the Int fields (see
-- prisma/staged-migrations/409-epoch-timestamptz/README.md).
--
-- Verifies again, then drops the sync triggers and the epoch columns. The
-- nine Int-column indexes go with their columns; their timestamptz twins
-- (migrations 20261021000001…09) already serve every query.
-- Rollback: down.sql re-adds the Int columns and the sync triggers; then run
-- `npm run db:backfill-timestamps -- --direction to-epoch` and rebuild the
-- Int indexes CONCURRENTLY (README). NOT NULL on the Int columns is only
-- restored once that backfill has finished.
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

DROP TRIGGER IF EXISTS "intents_sync_epoch_ts" ON "intents";
DROP TRIGGER IF EXISTS "solvers_sync_epoch_ts" ON "solvers";
DROP FUNCTION IF EXISTS "intents_sync_epoch_ts"();
DROP FUNCTION IF EXISTS "solvers_sync_epoch_ts"();

ALTER TABLE "intents"
    DROP COLUMN "created_at",
    DROP COLUMN "deadline",
    DROP COLUMN "filled_at";
ALTER TABLE "solvers"
    DROP COLUMN "registered_at",
    DROP COLUMN "last_active_at";
