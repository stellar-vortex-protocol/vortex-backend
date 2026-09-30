-- Migration: source-chain deposit verification for intents (issue #403)
--
-- * src_verified      — false until the escrow Deposited log is confirmed;
--                       GET /intents/open hides unverified intents and
--                       accept() rejects them.
-- * src_tx_hash       — optional EVM deposit tx supplied at creation.
-- * src_verification  — last verification result (status, block, amount).
--
-- Existing rows predate verification and are grandfathered as verified so a
-- deploy does not suddenly hide every live intent from solvers.
--
-- Guarded with to_regclass() so the migration-rollback CI job, which replays
-- each migration in isolation against an empty schema, can run it; in a real
-- deployment `intents` always exists and the guards are no-ops.
-- Rollback: down.sql (see docs/runbooks/evm-deposit-verification.md).

ALTER TABLE IF EXISTS "intents"
    ADD COLUMN IF NOT EXISTS "src_verified"     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "src_tx_hash"      TEXT,
    ADD COLUMN IF NOT EXISTS "src_verification" JSONB;

DO $$
BEGIN
    IF to_regclass('intents') IS NOT NULL THEN
        UPDATE "intents"
        SET "src_verified" = true,
            "src_verification" = jsonb_build_object(
                'status', 'grandfathered',
                'checkedAt', EXTRACT(EPOCH FROM NOW())::bigint,
                'detail', 'created before source-deposit verification (issue #403)'
            )
        WHERE "src_verification" IS NULL;

        -- GET /intents/open and the solver WS snapshot read exactly this slice.
        -- squawk-ignore create-index-without-concurrently
        -- justification: Prisma runs each migration in a transaction, which forbids CONCURRENTLY. The index is partial (open, verified intents only), so it is small; on very large tables pre-create it CONCURRENTLY out of band and IF NOT EXISTS makes this a no-op.
        CREATE INDEX IF NOT EXISTS "intents_open_verified_idx"
            ON "intents" ("created_at" DESC)
            WHERE "state" = 'open' AND "src_verified";
    END IF;
END $$;
