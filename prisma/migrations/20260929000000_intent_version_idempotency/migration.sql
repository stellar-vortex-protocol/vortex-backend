-- Migration: optimistic concurrency + cross-replica idempotency for intents
-- (issues #404 / #405).
--
-- * version          — incremented by every UPDATE; mutations are guarded with
--                      `WHERE version = $expected` so concurrent writers can
--                      never silently overwrite one another.
-- * idempotency_key  — unique, so two replicas racing POST /intents with the
--                      same key collapse onto one row via
--                      `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`.
-- * slashed_at / slash_reason — previously dropped by the Prisma adapter,
--                      which made the dual-write consistency verifier report
--                      every slashed intent as a mismatch.
-- * fee_amount       — declared in schema.prisma but never created by an
--                      earlier migration; added defensively.
--
-- Guarded with to_regclass() so the migration-rollback CI job, which replays
-- each migration in isolation against an empty schema, can run it; in a real
-- deployment `intents` always exists and the guard is a no-op.
-- Rollback: down.sql (see docs/runbooks/intents-store-migration.md).

ALTER TABLE IF EXISTS "intents"
    ADD COLUMN IF NOT EXISTS "fee_amount"      TEXT,
    ADD COLUMN IF NOT EXISTS "slashed_at"      INTEGER,
    ADD COLUMN IF NOT EXISTS "slash_reason"    TEXT,
    ADD COLUMN IF NOT EXISTS "version"         INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration in a transaction, which forbids CONCURRENTLY. idempotency_key is new and entirely NULL here, so the build is fast; on very large tables pre-create this index CONCURRENTLY out of band and IF NOT EXISTS makes this a no-op.
DO $$
BEGIN
    IF to_regclass('intents') IS NOT NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS "intents_idempotency_key_key" ON "intents" ("idempotency_key");
    END IF;
END $$;
