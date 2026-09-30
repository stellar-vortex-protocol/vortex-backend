-- Unsafe migration exercising each blocking-rule category.
CREATE INDEX "intents_src_chain_idx" ON "intents"("src_chain");

ALTER TABLE "intents" ALTER COLUMN "src_amount" TYPE NUMERIC;

ALTER TABLE "intents" ADD COLUMN "priority" INTEGER NOT NULL;

LOCK TABLE "intents" IN ACCESS EXCLUSIVE MODE;
