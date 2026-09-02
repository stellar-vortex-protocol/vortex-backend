-- Migration: add solvers.last_active_at (issue #56)
-- Tracks the most recent activity (registration, fill, or status change)
-- for a solver. Backfilled from registered_at for existing rows.

ALTER TABLE "solvers" ADD COLUMN "last_active_at" INTEGER;

UPDATE "solvers" SET "last_active_at" = "registered_at" WHERE "last_active_at" IS NULL;

ALTER TABLE "solvers" ALTER COLUMN "last_active_at" SET NOT NULL;
