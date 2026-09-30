DROP INDEX IF EXISTS "intents_src_chain_idx";

ALTER TABLE "intents" ALTER COLUMN "src_amount" TYPE TEXT;

ALTER TABLE "intents" DROP COLUMN IF EXISTS "priority";
