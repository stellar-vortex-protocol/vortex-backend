-- Fee ledger (issue #438). Application code rejects a batch unless debits equal credits.
CREATE TABLE "fee_ledger" (
    "id" TEXT NOT NULL,
    "intent_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fee_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fee_ledger_intent_id_idx" ON "fee_ledger"("intent_id");
CREATE INDEX "fee_ledger_account_created_at_idx" ON "fee_ledger"("account", "created_at");
