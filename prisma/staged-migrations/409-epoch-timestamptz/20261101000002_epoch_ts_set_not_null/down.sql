-- Rollback for step 3.
SET LOCAL lock_timeout = '1s';
ALTER TABLE "intents" ALTER COLUMN "created_at_ts" DROP NOT NULL;
ALTER TABLE "intents" ALTER COLUMN "deadline_ts" DROP NOT NULL;
ALTER TABLE "solvers" ALTER COLUMN "registered_at_ts" DROP NOT NULL;
ALTER TABLE "solvers" ALTER COLUMN "last_active_at_ts" DROP NOT NULL;
