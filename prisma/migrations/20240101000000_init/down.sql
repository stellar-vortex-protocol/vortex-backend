-- Down-migration for 20240101000000_init
-- Reverses migration.sql in this same directory. See prisma/migrations/README.md
-- for the rollback convention and CI verification job.

DROP TABLE IF EXISTS "tokens";
DROP TABLE IF EXISTS "solvers";
DROP TABLE IF EXISTS "intents";

DROP TYPE IF EXISTS "SupportedChain";
DROP TYPE IF EXISTS "IntentState";
