-- Migration: add intent_audit_log table (issue #217 / #62)
-- Append-only record of every state transition for an intent.
-- Schema specified in DATABASE_INDEXES.md section 3.

CREATE TABLE "intent_audit_log" (
    "id"         BIGSERIAL       PRIMARY KEY,
    "intent_id"  TEXT            NOT NULL REFERENCES "intents"("intent_id") ON DELETE CASCADE,
    "timestamp"  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    "to_state"   TEXT            NOT NULL,
    "actor"      TEXT            NOT NULL,
    "reason"     TEXT            NOT NULL,
    "metadata"   JSONB
);

-- Index for "give me the full history of intent X", oldest-first.
CREATE INDEX IF NOT EXISTS audit_log_intent_idx
    ON "intent_audit_log" ("intent_id", "timestamp" ASC);
