-- Safe SQL, but the directory intentionally has no down.sql to trigger the
-- missing-down-sql rule.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "intents_state_idx" ON "intents"("state");
