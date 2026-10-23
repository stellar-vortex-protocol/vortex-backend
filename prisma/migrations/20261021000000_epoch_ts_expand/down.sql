-- Rollback for issue #409 expand phase. Safe at any point before the staged
-- contract migration: the Int columns were never modified, so dropping the
-- timestamptz twins loses nothing. Roll back the index migrations first
-- (each has its own down.sql) or let DROP COLUMN drop those indexes.
SET LOCAL lock_timeout = '1s';
DROP TRIGGER IF EXISTS "intents_sync_epoch_ts" ON "intents";
DROP TRIGGER IF EXISTS "solvers_sync_epoch_ts" ON "solvers";
DROP FUNCTION IF EXISTS "intents_sync_epoch_ts"();
DROP FUNCTION IF EXISTS "solvers_sync_epoch_ts"();
ALTER TABLE "intents"
    DROP COLUMN IF EXISTS "created_at_ts",
    DROP COLUMN IF EXISTS "deadline_ts",
    DROP COLUMN IF EXISTS "filled_at_ts";
ALTER TABLE "solvers"
    DROP COLUMN IF EXISTS "registered_at_ts",
    DROP COLUMN IF EXISTS "last_active_at_ts";
