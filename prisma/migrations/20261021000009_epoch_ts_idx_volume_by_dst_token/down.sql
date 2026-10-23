-- Rollback: drop the timestamptz index built by this migration.
DROP INDEX CONCURRENTLY IF EXISTS "intents_volume_by_dst_token_ts_idx";
