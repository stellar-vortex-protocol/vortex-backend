-- Issue #427: partial fills.
--
-- Two additive columns on intents (both defaulted / nullable, so no rewrite
-- and no NOT NULL violation on existing rows) and the intent_fills tranche
-- table. Reservations are inserted under `SELECT ... FOR UPDATE` on the parent
-- intents row; see src/intents/partial-fills/prisma-intent-fills.repository.ts.
ALTER TABLE "intents" ADD COLUMN IF NOT EXISTS "allow_partial_fill" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "intents" ADD COLUMN IF NOT EXISTS "min_fill_amount" TEXT;

CREATE TYPE "IntentFillStatus" AS ENUM ('reserved', 'filled', 'slashed', 'released');

CREATE TABLE "intent_fills" (
  "id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "solver" TEXT NOT NULL,
  "reserved_amount" TEXT NOT NULL,
  "min_dst_amount" TEXT NOT NULL,
  "status" "IntentFillStatus" NOT NULL DEFAULT 'reserved',
  "reserved_at" INTEGER NOT NULL,
  "deadline" INTEGER NOT NULL,
  "dst_amount" TEXT,
  "fee_amount" TEXT,
  "tx_hash" TEXT,
  "filled_at" INTEGER,
  "slashed_at" INTEGER,
  "released_at" INTEGER,

  CONSTRAINT "intent_fills_pkey" PRIMARY KEY ("id")
);

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is created in this migration, so the build takes no meaningful lock.
CREATE INDEX "intent_fills_intent_idx" ON "intent_fills"("intent_id");

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is created in this migration, so the build takes no meaningful lock.
CREATE INDEX "intent_fills_status_deadline_idx" ON "intent_fills"("status", "deadline");
