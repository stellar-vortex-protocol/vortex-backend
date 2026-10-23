-- Rollback for step 1: drop the NOT VALID checks.
SET LOCAL lock_timeout = '1s';
ALTER TABLE "intents" DROP CONSTRAINT IF EXISTS "intents_created_at_ts_not_null";
ALTER TABLE "intents" DROP CONSTRAINT IF EXISTS "intents_deadline_ts_not_null";
ALTER TABLE "solvers" DROP CONSTRAINT IF EXISTS "solvers_registered_at_ts_not_null";
ALTER TABLE "solvers" DROP CONSTRAINT IF EXISTS "solvers_last_active_at_ts_not_null";
