-- Issue #409 — expand phase: timestamptz twin of "intents_user_created_idx".
-- Exactly one statement: Prisma only runs CREATE INDEX CONCURRENTLY outside a
-- transaction when it is the whole migration file. IF NOT EXISTS makes a
-- re-run after an interrupted build a no-op; an INVALID leftover index must be
-- dropped first (see prisma/migrations/README.md).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "intents_user_created_ts_idx" ON "intents" ("user", "created_at_ts" DESC);
