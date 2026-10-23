-- Rollback: drop the timestamptz index built by this migration.
DROP INDEX CONCURRENTLY IF EXISTS "intents_state_created_ts_idx";
