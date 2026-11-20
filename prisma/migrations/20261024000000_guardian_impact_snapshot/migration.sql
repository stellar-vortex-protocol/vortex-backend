-- Migration: guardian_impact_snapshot (issue #507)
-- Adds GuardianImpactSnapshot — a point-in-time blast-radius record captured
-- on guardian action activation (pause or solver blacklist).

CREATE TABLE "guardian_impact_snapshots" (
    "id"                   BIGSERIAL PRIMARY KEY,
    "action_id"            TEXT         NOT NULL,
    "kind"                 TEXT         NOT NULL,
    "solver_address"       TEXT,
    "open_intent_count"    INTEGER      NOT NULL,
    "affected_intent_ids"  TEXT[]       NOT NULL DEFAULT '{}',
    "captured_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "guardian_impact_snapshots_action_id_fkey"
        FOREIGN KEY ("action_id")
        REFERENCES "guardian_actions" ("id")
        ON DELETE CASCADE
);

-- One snapshot per action (1-to-1).
CREATE UNIQUE INDEX "guardian_impact_snapshots_action_id_key"
    ON "guardian_impact_snapshots" ("action_id");
