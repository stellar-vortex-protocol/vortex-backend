-- Issue #407 — optional cleanup (STAGED): drop the pre-partitioning table once
-- the swap has run in production long enough that rolling it back is no
-- longer wanted. Refuses if the legacy table holds a row the partitioned
-- table does not.
SET LOCAL lock_timeout = '1s';

DO $$
DECLARE
    missing bigint;
BEGIN
    IF to_regclass('"intent_audit_log_legacy"') IS NULL THEN
        RETURN;
    END IF;
    SELECT count(*) INTO missing
    FROM "intent_audit_log_legacy" o
    WHERE NOT EXISTS (
        SELECT 1 FROM "intent_audit_log" n WHERE n."id" = o."id" AND n."timestamp" = o."timestamp"
    );
    IF missing > 0 THEN
        RAISE EXCEPTION 'refusing to drop intent_audit_log_legacy: % rows are not in intent_audit_log', missing;
    END IF;
END $$;

DROP TABLE IF EXISTS "intent_audit_log_legacy";
