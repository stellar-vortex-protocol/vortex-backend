-- Migration: treasury_alerts
-- Persists TreasuryAlert rows raised by TreasuryService.alertDiscrepancy().

CREATE TABLE "treasury_alerts" (
    "id"               TEXT        NOT NULL,
    "severity"         TEXT        NOT NULL,
    "asset"            TEXT        NOT NULL,
    "discrepancy"      TEXT        NOT NULL,
    "message"          TEXT        NOT NULL,
    "timestamp"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    "acknowledged"     BOOLEAN     NOT NULL DEFAULT false,
    "acknowledged_at"  TIMESTAMPTZ,
    "acknowledged_by"  TEXT,

    CONSTRAINT "treasury_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "treasury_alerts_acknowledged_asset_idx"
    ON "treasury_alerts" ("acknowledged", "asset");

CREATE INDEX "treasury_alerts_timestamp_idx"
    ON "treasury_alerts" ("timestamp" DESC);
