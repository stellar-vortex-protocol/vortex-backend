-- Migration: add composite and partial indexes specified in DATABASE_INDEXES.md
-- Issue #218: Prisma's declarative schema cannot express partial indexes natively,
-- so these are added via a raw-SQL migration.

-- 1. Composite index: user + created_at DESC
--    Covers getByUser() with ORDER BY created_at DESC — becomes index-only at scale.
CREATE INDEX IF NOT EXISTS intents_user_created_idx
    ON intents ("user", created_at DESC);

-- 2. Composite index: state + created_at DESC
--    Covers getByState() with ORDER BY created_at DESC (e.g. sweeper's getByState("open")).
CREATE INDEX IF NOT EXISTS intents_state_created_idx
    ON intents (state, created_at DESC);

-- 3. Partial index: open intents only, ordered by created_at DESC
--    The sweeper polls this every 30 s — a partial index keeps it especially lean
--    because it only covers the hot minority of rows (open intents).
--    Requires PostgreSQL 12+.
CREATE INDEX IF NOT EXISTS intents_open_partial_idx
    ON intents (created_at DESC)
    WHERE state = 'open';
