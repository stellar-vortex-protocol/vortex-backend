-- Rollback for the swap. Copies rows written since the swap back into the
-- legacy table, swaps the names back and restores the mirror trigger, so the
-- partitioned table keeps receiving every row (phase 1 state).
SET LOCAL lock_timeout = '1s';

INSERT INTO "intent_audit_log_legacy" ("id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata")
SELECT "id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata"
FROM "intent_audit_log"
WHERE "id" > COALESCE((SELECT max("id") FROM "intent_audit_log_legacy"), 0)
ON CONFLICT DO NOTHING;

ALTER TABLE "intent_audit_log" RENAME CONSTRAINT "intent_audit_log_intent_id_fkey" TO "intent_audit_log_p_intent_id_fkey";
ALTER INDEX "audit_log_intent_idx" RENAME TO "audit_log_intent_p_idx";
ALTER INDEX "intent_audit_log_pkey" RENAME TO "intent_audit_log_p_pkey";
ALTER TABLE "intent_audit_log" RENAME TO "intent_audit_log_p";

ALTER TABLE "intent_audit_log_legacy" ALTER COLUMN "id" SET DEFAULT nextval('intent_audit_log_id_seq');
ALTER TABLE "intent_audit_log_legacy" RENAME CONSTRAINT "intent_audit_log_legacy_intent_id_fkey" TO "intent_audit_log_intent_id_fkey";
ALTER INDEX "audit_log_intent_legacy_idx" RENAME TO "audit_log_intent_idx";
ALTER INDEX "intent_audit_log_legacy_pkey" RENAME TO "intent_audit_log_pkey";
ALTER TABLE "intent_audit_log_legacy" RENAME TO "intent_audit_log";
ALTER SEQUENCE "intent_audit_log_id_seq" OWNED BY "intent_audit_log"."id";

CREATE OR REPLACE FUNCTION "intent_audit_log_mirror"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "intent_audit_log_p" ("id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata")
        VALUES (NEW."id", NEW."intent_id", NEW."timestamp", NEW."to_state", NEW."actor", NEW."reason", NEW."metadata")
        ON CONFLICT DO NOTHING;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        DELETE FROM "intent_audit_log_p" WHERE "id" = OLD."id" AND "timestamp" = OLD."timestamp";
        INSERT INTO "intent_audit_log_p" ("id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata")
        VALUES (NEW."id", NEW."intent_id", NEW."timestamp", NEW."to_state", NEW."actor", NEW."reason", NEW."metadata")
        ON CONFLICT DO NOTHING;
        RETURN NEW;
    ELSE
        DELETE FROM "intent_audit_log_p" WHERE "id" = OLD."id" AND "timestamp" = OLD."timestamp";
        RETURN OLD;
    END IF;
END;
$$;
CREATE TRIGGER "intent_audit_log_mirror"
    AFTER INSERT OR UPDATE OR DELETE ON "intent_audit_log"
    FOR EACH ROW EXECUTE FUNCTION "intent_audit_log_mirror"();
