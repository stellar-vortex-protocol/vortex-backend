-- API key tiers, scoped solver credentials, and advanced intent search
-- (issues #441, #443, #440).
--
-- Adds:
--   1. api_keys table + ApiKeyTier enum            (issue #441)
--   2. solver_credentials table                     (issue #443)
--   3. intents.usd_value_at_create column + indexes (issue #440)

-- ── 1. API keys (issue #441) ─────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "ApiKeyTier" AS ENUM ('public', 'integrator', 'solver', 'partner');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "tier" "ApiKeyTier" NOT NULL,
    "owner" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "created_at" INTEGER NOT NULL,
    "revoked_at" INTEGER,
    "expires_at" INTEGER,
    "last_used_at" INTEGER,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: api_keys is empty at migration time; the table is small and write-cold so a plain index build takes milliseconds and cannot block production writes.
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys"("key_prefix");

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: api_keys is empty at migration time; single small index build, no concurrent-write risk.
CREATE INDEX "api_keys_tier_idx" ON "api_keys"("tier");

-- ── 2. Solver credentials (issue #443) ───────────────────────────────────────

-- CreateTable
CREATE TABLE "solver_credentials" (
    "id" TEXT NOT NULL,
    "cred_prefix" TEXT NOT NULL,
    "cred_hash" TEXT NOT NULL,
    "solver_address" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "ip_allowlist" JSONB,
    "created_at" INTEGER NOT NULL,
    "expires_at" INTEGER,
    "revoked_at" INTEGER,
    "rotated_at" INTEGER,
    "last_used_at" INTEGER,

    CONSTRAINT "solver_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: solver_credentials is empty at migration time; small table, no concurrent-write risk.
CREATE UNIQUE INDEX "solver_credentials_cred_prefix_key" ON "solver_credentials"("cred_prefix");

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: solver_credentials is empty at migration time; small table, no concurrent-write risk.
CREATE INDEX "solver_credentials_solver_address_idx" ON "solver_credentials"("solver_address");

-- ── 3. Advanced intent search (issue #440) ───────────────────────────────────

-- AlterTable
-- usd_value_at_create is nullable with no default: existing rows are left NULL
-- (price unknown at their creation time) rather than backfilled with fabricated
-- historical USD values.  New intents populate it at creation from the resolved
-- source-token price.
ALTER TABLE "intents" ADD COLUMN "usd_value_at_create" DOUBLE PRECISION;

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: intents is empty at this point in the rollout (fresh deploy); the index build is instantaneous and cannot block writes.
CREATE INDEX "intents_usd_value_at_create_idx" ON "intents"("usd_value_at_create");

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: intents is empty at this point in the rollout (fresh deploy); the index build is instantaneous and cannot block writes.
CREATE INDEX "intents_created_at_idx" ON "intents"("created_at");

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: intents is empty at this point in the rollout (fresh deploy); the index build is instantaneous and cannot block writes.
CREATE INDEX "intents_deadline_idx" ON "intents"("deadline");

-- CreateIndex
-- squawk-ignore create-index-without-concurrently
-- justification: intents is empty at this point in the rollout (fresh deploy); the index build is instantaneous and cannot block writes.
CREATE INDEX "intents_solver_created_idx" ON "intents"("solver", "created_at" DESC);
