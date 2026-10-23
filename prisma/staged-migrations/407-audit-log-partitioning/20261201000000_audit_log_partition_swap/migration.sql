-- Issue #407 — phase 3: swap the partitioned table in (STAGED: move into
-- prisma/migrations only after `npm run db:backfill-audit-partitions -- --verify`
-- reports 0 missing rows).
--
-- 1. Verification guard: refuses (and changes nothing) if any live row is
--    missing from the partitioned copy. Read-only; no blocking locks.
-- 2. Drop the mirror trigger, then swap the table, index and constraint names
--    in this one transaction. Every statement is catalog-only; lock_timeout
--    makes it fail fast rather than queue behind a long transaction.
-- 3. Hand the id sequence to the new table so ids continue and dropping the
--    legacy table later cannot drop the sequence.
--
-- Prepared statements that referenced the old table are re-analysed after
-- the rename, so application inserts land in the partitioned table at once.
-- Rollback: down.sql (copies post-swap rows back and swaps the names back).

SET LOCAL lock_timeout = '1s';

DO $$
DECLARE
    missing bigint;
BEGIN
    SELECT count(*) INTO missing
    FROM "intent_audit_log" o
    WHERE NOT EXISTS (
        SELECT 1 FROM "intent_audit_log_p" n WHERE n."id" = o."id" AND n."timestamp" = o."timestamp"
    );
    IF missing > 0 THEN
        RAISE EXCEPTION 'audit-log partition swap refused: % rows not yet copied to intent_audit_log_p', missing
            USING HINT = 'Run `npm run db:backfill-audit-partitions` and re-check with --verify.';
    END IF;
END $$;

DROP TRIGGER IF EXISTS "intent_audit_log_mirror" ON "intent_audit_log";
DROP FUNCTION IF EXISTS "intent_audit_log_mirror"();

ALTER TABLE "intent_audit_log" RENAME TO "intent_audit_log_legacy";
ALTER INDEX "intent_audit_log_pkey" RENAME TO "intent_audit_log_legacy_pkey";
ALTER INDEX "audit_log_intent_idx" RENAME TO "audit_log_intent_legacy_idx";
ALTER TABLE "intent_audit_log_legacy" RENAME CONSTRAINT "intent_audit_log_intent_id_fkey" TO "intent_audit_log_legacy_intent_id_fkey";
ALTER TABLE "intent_audit_log_legacy" ALTER COLUMN "id" DROP DEFAULT;

ALTER TABLE "intent_audit_log_p" RENAME TO "intent_audit_log";
ALTER INDEX "intent_audit_log_p_pkey" RENAME TO "intent_audit_log_pkey";
ALTER INDEX "audit_log_intent_p_idx" RENAME TO "audit_log_intent_idx";
ALTER TABLE "intent_audit_log" RENAME CONSTRAINT "intent_audit_log_p_intent_id_fkey" TO "intent_audit_log_intent_id_fkey";

ALTER SEQUENCE "intent_audit_log_id_seq" OWNED BY "intent_audit_log"."id";
