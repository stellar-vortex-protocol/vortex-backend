-- Issue #407 — phase 1/3: range-partition intent_audit_log by month.
--
-- Zero-downtime plan:
--   1. (this migration) create the partitioned shadow table
--      "intent_audit_log_p", its default partition, monthly partitions from
--      the oldest row through three months ahead, and a trigger that mirrors
--      every INSERT/UPDATE/DELETE on the live table into it.
--   2. `npm run db:backfill-audit-partitions` copies existing rows in
--      keyset batches of at most 5k rows (resumable).
--   3. The staged swap migration (prisma/staged-migrations/407-audit-log-
--      partitioning/) verifies the copy and swaps the names in one short
--      transaction. The Prisma model keeps pointing at "intent_audit_log".
--
-- The shadow table shares the live table's sequence, so ids keep increasing
-- across the swap. Partitions are named intent_audit_log_yYYYYmMM whatever
-- the parent is called, so the swap needs no partition renames. The default
-- partition catches any row whose month has no partition yet (an insert
-- can never fail at a month boundary); intent_audit_log_ensure_partition()
-- moves such rows out when it creates the month's partition.
--
-- Locking: every statement creates new objects except CREATE TRIGGER on the
-- live table, which takes a brief SHARE ROW EXCLUSIVE lock.
-- Rollback: down.sql.

SET LOCAL lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS "intent_audit_log_p" (
    "id"        BIGINT      NOT NULL DEFAULT nextval('intent_audit_log_id_seq'),
    "intent_id" TEXT        NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "to_state"  TEXT        NOT NULL,
    "actor"     TEXT        NOT NULL,
    "reason"    TEXT        NOT NULL,
    "metadata"  JSONB,
    -- The partition key must be part of every unique constraint.
    CONSTRAINT "intent_audit_log_p_pkey" PRIMARY KEY ("id", "timestamp"),
    CONSTRAINT "intent_audit_log_p_intent_id_fkey" FOREIGN KEY ("intent_id")
        REFERENCES "intents"("intent_id") ON DELETE CASCADE
) PARTITION BY RANGE ("timestamp");

-- squawk-ignore create-index-without-concurrently
-- justification: PostgreSQL cannot build an index CONCURRENTLY on a partitioned parent, and this table was created empty by this migration, so the build is instant and blocks nobody.
CREATE INDEX IF NOT EXISTS "audit_log_intent_p_idx" ON "intent_audit_log_p" ("intent_id", "timestamp" ASC);

CREATE TABLE IF NOT EXISTS "intent_audit_log_default" PARTITION OF "intent_audit_log_p" DEFAULT;

-- Create the partition for the month containing `month_start` under `parent`
-- (idempotent). Bounds are UTC month starts. Rows that already fell into the
-- default partition for that month are moved into the new partition in the
-- same transaction, so creating a partition late never fails.
CREATE OR REPLACE FUNCTION "intent_audit_log_ensure_partition"(parent regclass, month_start date)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    m      date        := date_trunc('month', month_start)::date;
    lo     timestamptz := (date_trunc('month', month_start)::timestamp AT TIME ZONE 'UTC');
    hi     timestamptz := ((date_trunc('month', month_start) + interval '1 month')::timestamp AT TIME ZONE 'UTC');
    nsp    text;
    part   text        := format('intent_audit_log_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    dflt   text        := 'intent_audit_log_default';
    stray  bigint      := 0;
BEGIN
    SELECT n.nspname INTO nsp
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = parent;

    IF to_regclass(format('%I.%I', nsp, part)) IS NOT NULL THEN
        RETURN part;
    END IF;

    IF to_regclass(format('%I.%I', nsp, dflt)) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE "timestamp" >= $1 AND "timestamp" < $2', nsp, dflt)
            INTO stray USING lo, hi;
    END IF;

    IF stray = 0 THEN
        EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                       nsp, part, parent, lo, hi);
    ELSE
        EXECUTE format('CREATE TABLE %I.%I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', nsp, part, parent);
        EXECUTE format(
            'WITH moved AS (DELETE FROM %I.%I WHERE "timestamp" >= $1 AND "timestamp" < $2 RETURNING *) '
            'INSERT INTO %I.%I SELECT * FROM moved', nsp, dflt, nsp, part) USING lo, hi;
        EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I.%I FOR VALUES FROM (%L) TO (%L)',
                       parent, nsp, part, lo, hi);
    END IF;
    RETURN part;
END;
$$;

-- Partitions from the oldest existing row's month through three months ahead.
-- The oldest row is found through the primary key (ids follow insertion order).
DO $$
DECLARE
    first_month date;
    m           date;
BEGIN
    SELECT date_trunc('month', "timestamp")::date INTO first_month
    FROM "intent_audit_log" ORDER BY "id" LIMIT 1;
    m := LEAST(COALESCE(first_month, date_trunc('month', now())::date), date_trunc('month', now())::date);
    WHILE m <= (date_trunc('month', now()) + interval '3 months')::date LOOP
        PERFORM "intent_audit_log_ensure_partition"('"intent_audit_log_p"'::regclass, m);
        m := (m + interval '1 month')::date;
    END LOOP;
END $$;

-- Mirror every change on the live table into the shadow table until the swap.
CREATE OR REPLACE FUNCTION "intent_audit_log_mirror"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "intent_audit_log_p" ("id", "intent_id", "timestamp", "to_state", "actor", "reason", "metadata")
        VALUES (NEW."id", NEW."intent_id", NEW."timestamp", NEW."to_state", NEW."actor", NEW."reason", NEW."metadata")
        ON CONFLICT DO NOTHING;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- The log is append-only; mirrored anyway so the copy stays exact.
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

DROP TRIGGER IF EXISTS "intent_audit_log_mirror" ON "intent_audit_log";
CREATE TRIGGER "intent_audit_log_mirror"
    AFTER INSERT OR UPDATE OR DELETE ON "intent_audit_log"
    FOR EACH ROW EXECUTE FUNCTION "intent_audit_log_mirror"();
