-- Rollback for 20260929000000_intent_version_idempotency.
-- fee_amount is intentionally kept: schema.prisma has always declared it.
-- Data in the dropped columns (versions, idempotency keys, slash details) is lost.

-- squawk-ignore drop-index-without-concurrently
-- justification: runs inside Prisma's migration transaction, which forbids CONCURRENTLY; rollback is a change-managed operation.
DROP INDEX IF EXISTS "intents_idempotency_key_key";

ALTER TABLE IF EXISTS "intents"
    DROP COLUMN IF EXISTS "idempotency_key",
    DROP COLUMN IF EXISTS "version",
    DROP COLUMN IF EXISTS "slash_reason",
    DROP COLUMN IF EXISTS "slashed_at";
