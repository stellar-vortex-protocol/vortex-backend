-- Migration: #386 pending_transactions, #387 (schema support), #388 (fee_bump_count),
--            #389 ingestion_cursor, processed_events, dead_letter_events

CREATE TYPE "PendingTxStatus" AS ENUM ('pending', 'confirmed', 'failed', 'expired');

CREATE TABLE "pending_transactions" (
    "id" BIGSERIAL NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "tx_xdr" TEXT NOT NULL,
    "intent_id" TEXT,
    "channel_key" TEXT,
    "status" "PendingTxStatus" NOT NULL DEFAULT 'pending',
    "max_track_until" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_poll_at" INTEGER NOT NULL DEFAULT 0,
    "last_fee_stroops" TEXT,
    "fee_bump_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pending_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_transactions_tx_hash_key" ON "pending_transactions"("tx_hash");
CREATE INDEX "pending_tx_poll_idx" ON "pending_transactions"("status", "next_poll_at");
CREATE INDEX "pending_tx_intent_idx" ON "pending_transactions"("intent_id");

CREATE TABLE "ingestion_cursor" (
    "id" BIGSERIAL NOT NULL,
    "network" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "last_ledger" INTEGER NOT NULL,
    "last_event_idx" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ingestion_cursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ingestion_cursor_uniq" ON "ingestion_cursor"("network", "contract_id");

CREATE TABLE "processed_events" (
    "id" BIGSERIAL NOT NULL,
    "ledger" INTEGER NOT NULL,
    "event_index" INTEGER NOT NULL,
    "contract_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "processed_event_uniq" ON "processed_events"("ledger", "event_index", "contract_id", "network");
CREATE INDEX "processed_event_lookup_idx" ON "processed_events"("ledger", "event_index");

CREATE TABLE "dead_letter_events" (
    "id" BIGSERIAL NOT NULL,
    "ledger" INTEGER NOT NULL,
    "event_index" INTEGER NOT NULL,
    "contract_id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "last_error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dead_letter_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dead_letter_event_idx" ON "dead_letter_events"("ledger", "event_index");
