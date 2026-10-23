-- Issue #409 — expand phase 1/3: epoch-second INTEGER columns → timestamptz.
--
-- Adds a nullable timestamptz twin next to every epoch column:
--
--   intents.created_at     → intents.created_at_ts
--   intents.deadline       → intents.deadline_ts
--   intents.filled_at      → intents.filled_at_ts
--   solvers.registered_at  → solvers.registered_at_ts
--   solvers.last_active_at → solvers.last_active_at_ts
--
-- Dual-write: the repositories write both columns, and these BEFORE triggers
-- keep the pair in sync for any writer that only knows one side — an old
-- replica during the rolling deploy (Int only), the backfill (ts only), or a
-- future release that has stopped writing the Int column. On UPDATE the side
-- the writer changed wins; on INSERT the missing side is derived.
--
-- Existing rows are filled by `npm run db:backfill-timestamps` (resumable,
-- ≤ 5k rows per transaction). Indexes are built CONCURRENTLY by the
-- following single-statement migrations. NOT NULL and the Int-column drop are
-- staged in prisma/staged-migrations/ — see prisma/migrations/README.md
-- ("Expand/contract: epoch → timestamptz").
--
-- Locking: ADD COLUMN without a default is catalog-only; CREATE TRIGGER takes
-- a brief SHARE ROW EXCLUSIVE lock. lock_timeout makes the deploy fail fast
-- instead of queueing behind a long transaction.
-- Rollback: down.sql (drops the triggers and the new columns; Int data untouched).

SET LOCAL lock_timeout = '1s';

ALTER TABLE "intents"
    ADD COLUMN IF NOT EXISTS "created_at_ts" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "deadline_ts"   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "filled_at_ts"  TIMESTAMPTZ;

ALTER TABLE "solvers"
    ADD COLUMN IF NOT EXISTS "registered_at_ts"  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "last_active_at_ts" TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION "intents_sync_epoch_ts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
    IF NEW."created_at_ts" IS NULL AND NEW."created_at" IS NOT NULL THEN
        NEW."created_at_ts" := to_timestamp(NEW."created_at");
    ELSIF NEW."created_at" IS NULL AND NEW."created_at_ts" IS NOT NULL THEN
        NEW."created_at" := floor(extract(epoch FROM NEW."created_at_ts"))::integer;
    END IF;
    IF NEW."deadline_ts" IS NULL AND NEW."deadline" IS NOT NULL THEN
        NEW."deadline_ts" := to_timestamp(NEW."deadline");
    ELSIF NEW."deadline" IS NULL AND NEW."deadline_ts" IS NOT NULL THEN
        NEW."deadline" := floor(extract(epoch FROM NEW."deadline_ts"))::integer;
    END IF;
    IF NEW."filled_at_ts" IS NULL AND NEW."filled_at" IS NOT NULL THEN
        NEW."filled_at_ts" := to_timestamp(NEW."filled_at");
    ELSIF NEW."filled_at" IS NULL AND NEW."filled_at_ts" IS NOT NULL THEN
        NEW."filled_at" := floor(extract(epoch FROM NEW."filled_at_ts"))::integer;
    END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: mirror whichever side this writer changed.
    IF NEW."created_at" IS DISTINCT FROM OLD."created_at" AND NEW."created_at_ts" IS NOT DISTINCT FROM OLD."created_at_ts" THEN
        NEW."created_at_ts" := to_timestamp(NEW."created_at");
    ELSIF NEW."created_at_ts" IS DISTINCT FROM OLD."created_at_ts" AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at" THEN
        NEW."created_at" := floor(extract(epoch FROM NEW."created_at_ts"))::integer;
    END IF;
    IF NEW."deadline" IS DISTINCT FROM OLD."deadline" AND NEW."deadline_ts" IS NOT DISTINCT FROM OLD."deadline_ts" THEN
        NEW."deadline_ts" := to_timestamp(NEW."deadline");
    ELSIF NEW."deadline_ts" IS DISTINCT FROM OLD."deadline_ts" AND NEW."deadline" IS NOT DISTINCT FROM OLD."deadline" THEN
        NEW."deadline" := floor(extract(epoch FROM NEW."deadline_ts"))::integer;
    END IF;
    IF NEW."filled_at" IS DISTINCT FROM OLD."filled_at" AND NEW."filled_at_ts" IS NOT DISTINCT FROM OLD."filled_at_ts" THEN
        NEW."filled_at_ts" := to_timestamp(NEW."filled_at");
    ELSIF NEW."filled_at_ts" IS DISTINCT FROM OLD."filled_at_ts" AND NEW."filled_at" IS NOT DISTINCT FROM OLD."filled_at" THEN
        NEW."filled_at" := floor(extract(epoch FROM NEW."filled_at_ts"))::integer;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "solvers_sync_epoch_ts"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
    IF NEW."registered_at_ts" IS NULL AND NEW."registered_at" IS NOT NULL THEN
        NEW."registered_at_ts" := to_timestamp(NEW."registered_at");
    ELSIF NEW."registered_at" IS NULL AND NEW."registered_at_ts" IS NOT NULL THEN
        NEW."registered_at" := floor(extract(epoch FROM NEW."registered_at_ts"))::integer;
    END IF;
    IF NEW."last_active_at_ts" IS NULL AND NEW."last_active_at" IS NOT NULL THEN
        NEW."last_active_at_ts" := to_timestamp(NEW."last_active_at");
    ELSIF NEW."last_active_at" IS NULL AND NEW."last_active_at_ts" IS NOT NULL THEN
        NEW."last_active_at" := floor(extract(epoch FROM NEW."last_active_at_ts"))::integer;
    END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: mirror whichever side this writer changed.
    IF NEW."registered_at" IS DISTINCT FROM OLD."registered_at" AND NEW."registered_at_ts" IS NOT DISTINCT FROM OLD."registered_at_ts" THEN
        NEW."registered_at_ts" := to_timestamp(NEW."registered_at");
    ELSIF NEW."registered_at_ts" IS DISTINCT FROM OLD."registered_at_ts" AND NEW."registered_at" IS NOT DISTINCT FROM OLD."registered_at" THEN
        NEW."registered_at" := floor(extract(epoch FROM NEW."registered_at_ts"))::integer;
    END IF;
    IF NEW."last_active_at" IS DISTINCT FROM OLD."last_active_at" AND NEW."last_active_at_ts" IS NOT DISTINCT FROM OLD."last_active_at_ts" THEN
        NEW."last_active_at_ts" := to_timestamp(NEW."last_active_at");
    ELSIF NEW."last_active_at_ts" IS DISTINCT FROM OLD."last_active_at_ts" AND NEW."last_active_at" IS NOT DISTINCT FROM OLD."last_active_at" THEN
        NEW."last_active_at" := floor(extract(epoch FROM NEW."last_active_at_ts"))::integer;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "intents_sync_epoch_ts" ON "intents";
CREATE TRIGGER "intents_sync_epoch_ts"
    BEFORE INSERT OR UPDATE ON "intents"
    FOR EACH ROW EXECUTE FUNCTION "intents_sync_epoch_ts"();

DROP TRIGGER IF EXISTS "solvers_sync_epoch_ts" ON "solvers";
CREATE TRIGGER "solvers_sync_epoch_ts"
    BEFORE INSERT OR UPDATE ON "solvers"
    FOR EACH ROW EXECUTE FUNCTION "solvers_sync_epoch_ts"();
