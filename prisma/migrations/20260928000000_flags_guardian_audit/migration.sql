-- Migration: admin audit log, runtime feature flags and guardian actions
-- (issues #495 / #507).

CREATE TABLE "admin_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_audit_log_target_created_at_idx" ON "admin_audit_log"("target", "created_at" DESC);

CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "default_value" BOOLEAN NOT NULL,
    "rules" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "flag_change_requests" (
    "id" TEXT NOT NULL,
    "flag_key" TEXT NOT NULL,
    "proposed" JSONB NOT NULL,
    "proposed_by" TEXT NOT NULL,
    "approvals" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ,
    CONSTRAINT "flag_change_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "flag_change_requests_flag_key_status_idx" ON "flag_change_requests"("flag_key", "status");

CREATE TABLE "guardian_actions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "activated_at" TIMESTAMPTZ NOT NULL,
    "cleared_at" TIMESTAMPTZ,
    "cleared_tx_hash" TEXT,
    "overridden_by" TEXT,
    CONSTRAINT "guardian_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "guardian_actions_active_idx" ON "guardian_actions"("active");
