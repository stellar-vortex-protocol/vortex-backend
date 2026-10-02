-- Migration: processed_events + dead_letter_events
-- These tables support the versioned event decoder registry (#390),
-- ledger-gap backfill (#391), and chain-authoritative reconciler (#392).
--
-- 20260926000000_tx_confirmation_channel_pool_ingestion created provisional,
-- network-keyed tables under these same names as part of its ingestion work.
-- This migration is the authoritative definition (keyed by the RPC event id
-- "<ledger>-<index>"), so on a database that has already run the earlier
-- migration the provisional tables are dropped and recreated in the final
-- shape. Without that drop, a fresh `prisma migrate deploy` fails with
-- "relation already exists".

DROP TABLE IF EXISTS "processed_events";
DROP TABLE IF EXISTS "dead_letter_events";

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

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is fresh (or freshly recreated) in this migration, so the build takes no meaningful lock.
CREATE UNIQUE INDEX "processed_events_ledger_idx_key"
  ON "processed_events" ("ledger", "event_index");

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is fresh (or freshly recreated) in this migration, so the build takes no meaningful lock.
CREATE INDEX "processed_events_ledger_idx"
  ON "processed_events" ("ledger");

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is fresh (or freshly recreated) in this migration, so the build takes no meaningful lock.
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

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration inside a transaction, which forbids CREATE INDEX CONCURRENTLY; the table is fresh (or freshly recreated) in this migration, so the build takes no meaningful lock.
CREATE INDEX "dead_letter_events_ledger_idx"
  ON "dead_letter_events" ("ledger");
