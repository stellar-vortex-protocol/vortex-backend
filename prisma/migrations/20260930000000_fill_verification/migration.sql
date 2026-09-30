CREATE TYPE "FillVerificationState" AS ENUM ('pending', 'verified', 'rejected');

ALTER TABLE "intents"
  ADD COLUMN "fill_verification_state" "FillVerificationState",
  ADD COLUMN "fill_verification_reason" TEXT,
  ADD COLUMN "fill_verified_at" TIMESTAMPTZ;

-- Existing intents may have NULL tx_hash. If historic non-NULL duplicates
-- exist, this fails safely and must be resolved before this migration retries.
CREATE UNIQUE INDEX "intents_tx_hash_key" ON "intents"("tx_hash");
