-- Rollback: drop the timestamptz index built by this migration.
DROP INDEX CONCURRENTLY IF EXISTS "intents_created_at_ts_idx";
