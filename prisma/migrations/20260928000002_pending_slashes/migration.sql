-- Migration: durable slashing saga state (issue #397).

CREATE TYPE "PendingSlashState" AS ENUM ('detected', 'challenge_window', 'submitted', 'confirmed', 'cancelled');

CREATE TABLE "pending_slashes" (
    "id"                TEXT                 PRIMARY KEY,
    "intent_id"         TEXT                 NOT NULL,
    "solver_address"    TEXT                 NOT NULL,
    "reason"            TEXT                 NOT NULL,
    "state"             "PendingSlashState"  NOT NULL DEFAULT 'detected',
    "fill_deadline"     INTEGER              NOT NULL,
    "detected_at"       TIMESTAMPTZ          NOT NULL,
    "challenge_ends_at" TIMESTAMPTZ          NOT NULL,
    "attempts"          INTEGER              NOT NULL DEFAULT 0,
    "next_attempt_at"   TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    "locked_until"      TIMESTAMPTZ,
    "tx_hash"           TEXT,
    "simulated"         BOOLEAN              NOT NULL DEFAULT FALSE,
    "submitted_at"      TIMESTAMPTZ,
    "confirmed_at"      TIMESTAMPTZ,
    "cancelled_at"      TIMESTAMPTZ,
    "cancel_reason"     TEXT,
    "cancelled_by"      TEXT,
    "fill_tx_hash"      TEXT,
    "last_error"        TEXT,
    "created_at"        TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    "updated_at"        TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);

-- Exactly-once slash per intent.
CREATE UNIQUE INDEX "pending_slashes_intent_id_key" ON "pending_slashes" ("intent_id");
CREATE INDEX "pending_slashes_due_idx" ON "pending_slashes" ("state", "challenge_ends_at");
CREATE INDEX "pending_slashes_solver_idx" ON "pending_slashes" ("solver_address");
