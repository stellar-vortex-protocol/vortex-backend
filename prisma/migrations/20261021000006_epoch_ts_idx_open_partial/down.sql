-- Rollback: drop the timestamptz index built by this migration.
DROP INDEX CONCURRENTLY IF EXISTS "intents_open_partial_ts_idx";
