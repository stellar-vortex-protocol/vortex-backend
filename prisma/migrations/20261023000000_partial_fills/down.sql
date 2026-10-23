-- Rollback for 20261023000000_partial_fills. Drops every tranche record.
DROP TABLE IF EXISTS "intent_fills";
DROP TYPE IF EXISTS "IntentFillStatus";
ALTER TABLE "intents" DROP COLUMN IF EXISTS "min_fill_amount";
ALTER TABLE "intents" DROP COLUMN IF EXISTS "allow_partial_fill";
