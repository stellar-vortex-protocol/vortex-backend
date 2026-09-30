-- CreateTable
CREATE TABLE "treasury_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "snapshot_date" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "expected_balance" TEXT NOT NULL,
    "actual_balance" TEXT NOT NULL,
    "discrepancy" TEXT NOT NULL,
    "tolerance_threshold" TEXT NOT NULL,
    "has_unexplained_discrepancy" BOOLEAN NOT NULL,
    "explanation" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "breakdown" JSONB,

    CONSTRAINT "treasury_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_ledger" (
    "id" BIGSERIAL NOT NULL,
    "intent_id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "accrual_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tx_hash" TEXT,

    CONSTRAINT "fee_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slash_ledger" (
    "id" BIGSERIAL NOT NULL,
    "solver_address" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "slashed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "tx_hash" TEXT,

    CONSTRAINT "slash_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_ledger" (
    "id" BIGSERIAL NOT NULL,
    "intent_id" TEXT NOT NULL,
    "user_address" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "tx_hash" TEXT,

    CONSTRAINT "refund_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treasury_snapshots_snapshot_date_idx" ON "treasury_snapshots"("snapshot_date");

-- CreateIndex
CREATE INDEX "treasury_snapshots_has_unexplained_discrepancy_idx" ON "treasury_snapshots"("has_unexplained_discrepancy");

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_date_asset_unique" ON "treasury_snapshots"("snapshot_date", "asset");

-- CreateIndex
CREATE INDEX "fee_ledger_intent_id_idx" ON "fee_ledger"("intent_id");

-- CreateIndex
CREATE INDEX "fee_ledger_asset_accrual_at_idx" ON "fee_ledger"("asset", "accrual_at");

-- CreateIndex
CREATE INDEX "slash_ledger_solver_address_idx" ON "slash_ledger"("solver_address");

-- CreateIndex
CREATE INDEX "slash_ledger_asset_slashed_at_idx" ON "slash_ledger"("asset", "slashed_at");

-- CreateIndex
CREATE INDEX "refund_ledger_intent_id_idx" ON "refund_ledger"("intent_id");

-- CreateIndex
CREATE INDEX "refund_ledger_user_address_idx" ON "refund_ledger"("user_address");

-- CreateIndex
CREATE INDEX "refund_ledger_asset_issued_at_idx" ON "refund_ledger"("asset", "issued_at");
