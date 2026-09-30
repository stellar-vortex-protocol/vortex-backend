-- Migration: transactional outbox for on-chain writes (issue #396).
-- No FK to intents: outbox rows must outlive in-memory/retention-evicted intents
-- and the migration must apply standalone in the rollback CI job.

CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'submitted', 'confirmed', 'simulated', 'dead');

CREATE TABLE "onchain_outbox" (
    "id"              BIGSERIAL       PRIMARY KEY,
    "intent_id"       TEXT            NOT NULL,
    "operation"       TEXT            NOT NULL,
    "payload"         JSONB           NOT NULL,
    "status"          "OutboxStatus"  NOT NULL DEFAULT 'pending',
    "attempts"        INTEGER         NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "locked_until"    TIMESTAMPTZ,
    "envelope_hash"   TEXT,
    "tx_hash"         TEXT,
    "last_error"      TEXT,
    "created_at"      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "updated_at"      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Relay claim scan: due rows by status.
CREATE INDEX "onchain_outbox_claim_idx" ON "onchain_outbox" ("status", "next_attempt_at");
-- Per-intent ordering check ("is there an earlier unfinished row for this intent?").
CREATE INDEX "onchain_outbox_intent_order_idx" ON "onchain_outbox" ("intent_id", "id");
