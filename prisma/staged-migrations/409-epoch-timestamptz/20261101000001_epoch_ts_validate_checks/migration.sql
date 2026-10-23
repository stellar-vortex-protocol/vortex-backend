-- Issue #409 — contract phase, step 2/4 (STAGED).
-- VALIDATE CONSTRAINT scans each table under SHARE UPDATE EXCLUSIVE, which
-- does not block reads or writes.
-- Rollback: nothing to undo (down.sql of step 1 removes the constraints).
ALTER TABLE "intents" VALIDATE CONSTRAINT "intents_created_at_ts_not_null";
ALTER TABLE "intents" VALIDATE CONSTRAINT "intents_deadline_ts_not_null";
ALTER TABLE "solvers" VALIDATE CONSTRAINT "solvers_registered_at_ts_not_null";
ALTER TABLE "solvers" VALIDATE CONSTRAINT "solvers_last_active_at_ts_not_null";
