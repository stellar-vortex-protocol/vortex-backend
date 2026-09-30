-- Unsafe DDL, but each violation is suppressed with a required justification.
-- squawk-ignore create-index-without-concurrently
-- justification: the intents table is empty at this point in the rollout
CREATE INDEX "intents_src_chain_idx" ON "intents"("src_chain");

-- squawk-ignore lock-table -- justification: table is read-only during this maintenance window
LOCK TABLE "intents" IN ACCESS EXCLUSIVE MODE;
