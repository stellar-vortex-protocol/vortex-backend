-- Rollback for 20260929000002_intent_src_verification.
-- Verification state (status, block, received amount) is lost.

-- squawk-ignore drop-index-without-concurrently
-- justification: runs inside Prisma's migration transaction, which forbids CONCURRENTLY; rollback is a change-managed operation.
DROP INDEX IF EXISTS "intents_open_verified_idx";

ALTER TABLE IF EXISTS "intents"
    DROP COLUMN IF EXISTS "src_verification",
    DROP COLUMN IF EXISTS "src_tx_hash",
    DROP COLUMN IF EXISTS "src_verified";
