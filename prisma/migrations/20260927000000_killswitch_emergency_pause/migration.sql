-- Migration: emergency kill-switches (issue #477)
--
-- Adds the hierarchical pause surface (global / chain / token / operation) plus
-- the two-approval ledger that gates resuming a switch.
--
-- Notes on two decisions that are easy to misread later:
--
-- 1. Both "scope" and "operation" are Postgres enums, matching the Prisma
--    schema. Note that the Prisma enum for operation maps to a real enum type
--    here, so adding a sixth operation does require a migration. The hot path
--    is unaffected — the application constrains the accepted values before
--    this layer — but the column type must stay in sync with schema.prisma or
--    every query against it fails on a type mismatch.
-- 2. scope_key is a non-null canonical encoding of
--    (scope, chain, token, operation). Prisma cannot build a findUnique over
--    nullable columns, so a surrogate carries the uniqueness guarantee while
--    the typed columns stay individually queryable.

CREATE TYPE "KillSwitchScope" AS ENUM ('global', 'chain', 'token', 'operation');

CREATE TYPE "KillSwitchOperation" AS ENUM ('create', 'accept', 'fill', 'slash', 'onchain');

CREATE TABLE "kill_switches" (
    "id"                TEXT             NOT NULL,
    "scope"             "KillSwitchScope" NOT NULL,
    "chain"             TEXT,
    "token"             TEXT,
    "operation"         "KillSwitchOperation",
    "scope_key"         TEXT             NOT NULL,
    "active"            BOOLEAN          NOT NULL,
    "reason_code"       TEXT             NOT NULL,
    "reason"            TEXT             NOT NULL,
    "activated_by"      TEXT             NOT NULL,
    "updated_at"        INTEGER          NOT NULL,
    "created_at"        INTEGER          NOT NULL,
    "last_resumed_at"   INTEGER,
    "approvals_required" INTEGER         NOT NULL DEFAULT 2,

    CONSTRAINT "kill_switches_pkey" PRIMARY KEY ("id")
);

-- Uniqueness of the scope tuple. Repeated pauses of the same scope update the
-- existing row rather than accumulating history, which is what lets the resume
-- counter and the polling change-detection both stay meaningful.
CREATE UNIQUE INDEX "kill_switches_scope_key_key" ON "kill_switches"("scope_key");

CREATE INDEX "kill_switches_active_idx" ON "kill_switches"("active");

-- Supports the per-target evaluation query:
--   WHERE scope = ? AND chain IS NOT DISTINCT FROM ? AND ...
CREATE INDEX "kill_switches_scope_chain_token_operation_idx"
    ON "kill_switches"("scope", "chain", "token", "operation");

-- Supports the polling fallback, which asks "did anything change since the
-- last snapshot?" via max(updated_at).
CREATE INDEX "kill_switches_updated_at_idx" ON "kill_switches"("updated_at");

CREATE TABLE "kill_switch_approvals" (
    "id"            TEXT NOT NULL,
    "kill_switch_id" TEXT NOT NULL,
    "approver"      TEXT NOT NULL,
    "approved_at"   INTEGER NOT NULL,
    "note"          TEXT,

    CONSTRAINT "kill_switch_approvals_pkey" PRIMARY KEY ("id")
);

-- One approval per operator per switch: this is the constraint that makes the
-- two-approval rule meaningful. A second POST from the same x-operator-id
-- conflicts rather than incrementing the count.
CREATE UNIQUE INDEX "kill_switch_approvals_kill_switch_id_approver_key"
    ON "kill_switch_approvals"("kill_switch_id", "approver");

CREATE INDEX "kill_switch_approvals_kill_switch_id_idx"
    ON "kill_switch_approvals"("kill_switch_id");

ALTER TABLE "kill_switch_approvals"
    ADD CONSTRAINT "kill_switch_approvals_kill_switch_id_fkey"
    FOREIGN KEY ("kill_switch_id") REFERENCES "kill_switches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: leave the table empty. No switch is active, so the service is in
-- its ready state and every write is permitted. Recording a synthetic
-- "all clear" row would be wrong — it would surface in the operator API as an
-- explicit resume that never happened.
