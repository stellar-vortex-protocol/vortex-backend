-- Migration: processed_events + dead_letter_events
-- These tables support the versioned event decoder registry (#390),
-- ledger-gap backfill (#391), and chain-authoritative reconciler (#392).

-- ─── processed_events ────────────────────────────────────────────────────────
-- Idempotency table: one row per confirmed-processed Soroban event.
-- The unique index on (ledger, event_index) ensures at-most-once delivery
-- across both the live ingestion cursor and the backfill runner.
CREATE TABLE "processed_events" (
  "id"           BIGSERIAL PRIMARY KEY,
  "event_id"     TEXT        NOT NULL,          -- RPC event id "<ledger>-<index>"
  "ledger"       INTEGER     NOT NULL,
  "event_index"  INTEGER     NOT NULL,
  "contract_id"  TEXT        NOT NULL,
  "topic"        TEXT        NOT NULL,          -- decoded topic[0] string
  "tx_hash"      TEXT        NOT NULL,
  "processed_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "processed_events_ledger_idx_key"
  ON "processed_events" ("ledger", "event_index");

CREATE INDEX "processed_events_ledger_idx"
  ON "processed_events" ("ledger");

CREATE INDEX "processed_events_contract_idx"
  ON "processed_events" ("contract_id");

-- ─── dead_letter_events ───────────────────────────────────────────────────────
-- Known-topic events that failed schema validation are written here instead
-- of being silently dropped. Operators can replay them after a contract
-- upgrade fixes the schema mismatch.
CREATE TABLE "dead_letter_events" (
  "id"           BIGSERIAL PRIMARY KEY,
  "event_id"     TEXT        NOT NULL,
  "ledger"       INTEGER     NOT NULL,
  "tx_hash"      TEXT        NOT NULL,
  "raw_topic"    TEXT        NOT NULL,
  "error"        TEXT        NOT NULL,
  "raw_xdr"      TEXT        NOT NULL,          -- JSON-encoded base64 XDR topic array
  "occurred_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "dead_letter_events_ledger_idx"
  ON "dead_letter_events" ("ledger");
