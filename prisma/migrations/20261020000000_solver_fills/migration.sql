-- Issue #417 — per-fill metrics table.
--
-- One immutable row per fill outcome, written by the application in the same
-- transaction as the accepted -> filled / accepted -> slashed transition.
-- Solver statistics (windows, p50/p95 fill times, USD volume) are derived from
-- this table; solvers.total_volume / fills_completed / fills_failed /
-- avg_fill_time are kept as a compatibility projection.

-- `reversed` is a compensating row appended when the slashing saga cancels a
-- slash; it carries the failed row's timestamp so the pair always falls in the
-- same window, and stats count failures as failed - reversed.
CREATE TYPE "solver_fill_outcome" AS ENUM ('filled', 'failed', 'reversed');

CREATE TABLE "solver_fills" (
    "id"           BIGSERIAL             NOT NULL,
    "intent_id"    TEXT                  NOT NULL,
    "solver"       TEXT                  NOT NULL,
    "chain"        "SupportedChain"      NOT NULL,
    "src_amount"   NUMERIC(78, 0)        NOT NULL,
    "dst_amount"   NUMERIC(78, 0),
    "usd_value"    NUMERIC(38, 8),
    "fill_seconds" INTEGER,
    "outcome"      "solver_fill_outcome" NOT NULL,
    "ledger"       INTEGER,
    "created_at"   TIMESTAMPTZ           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "solver_fills_pkey" PRIMARY KEY ("id")
);

-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration in a transaction, which forbids CONCURRENTLY; solver_fills is created empty in this migration, so the build takes no meaningful lock.
CREATE UNIQUE INDEX "solver_fills_intent_outcome_key" ON "solver_fills"("intent_id", "outcome");

-- squawk-ignore create-index-without-concurrently
-- justification: solver_fills is created empty in this migration (see above).
CREATE INDEX "solver_fills_solver_created_idx" ON "solver_fills"("solver", "created_at");

-- squawk-ignore create-index-without-concurrently
-- justification: solver_fills is created empty in this migration (see above).
CREATE INDEX "solver_fills_created_idx" ON "solver_fills"("created_at");

-- ── One-time backfill from existing intents ─────────────────────────────────
-- Filled intents (including fills still awaiting chain confirmation) become
-- `filled` rows timestamped at filled_at; slashed intents become `failed` rows
-- timestamped at slashed_at. fill_seconds keeps the pre-existing definition
-- (filled_at - created_at) so historical windows line up with the old stats.
--
-- usd_value is left NULL: the price at fill time was never recorded, and the
-- contract for this column is "snapshot at fill time, never recomputed", so a
-- present-day price must not be written here. Non-integer legacy amounts are
-- counted as 0 rather than aborting the migration.

INSERT INTO "solver_fills"
    ("intent_id", "solver", "chain", "src_amount", "dst_amount", "usd_value",
     "fill_seconds", "outcome", "ledger", "created_at")
SELECT
    i."intent_id",
    i."solver",
    i."src_chain",
    CASE WHEN i."src_amount" ~ '^[0-9]+$' THEN i."src_amount"::NUMERIC ELSE 0 END,
    CASE WHEN i."fill_amount" ~ '^[0-9]+$' THEN i."fill_amount"::NUMERIC ELSE 0 END,
    NULL,
    i."filled_at" - i."created_at",
    'filled',
    NULL,
    to_timestamp(i."filled_at")
FROM "intents" i
WHERE i."state" IN ('filled', 'pending_filled')
  AND i."solver" IS NOT NULL
  AND i."filled_at" IS NOT NULL
ON CONFLICT ("intent_id", "outcome") DO NOTHING;

INSERT INTO "solver_fills"
    ("intent_id", "solver", "chain", "src_amount", "dst_amount", "usd_value",
     "fill_seconds", "outcome", "ledger", "created_at")
SELECT
    i."intent_id",
    i."solver",
    i."src_chain",
    CASE WHEN i."src_amount" ~ '^[0-9]+$' THEN i."src_amount"::NUMERIC ELSE 0 END,
    NULL,
    NULL,
    NULL,
    'failed',
    NULL,
    to_timestamp(COALESCE(i."slashed_at", i."created_at"))
FROM "intents" i
WHERE i."state" = 'slashed'
  AND i."solver" IS NOT NULL
ON CONFLICT ("intent_id", "outcome") DO NOTHING;
