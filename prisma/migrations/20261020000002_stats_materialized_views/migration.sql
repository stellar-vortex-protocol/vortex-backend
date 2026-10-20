-- Issue #416 — materialised read models for /stats, /stats/public,
-- /stats/treasury and the all-time solver leaderboard.
--
-- Each view carries a unique index so the refresh worker can run
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (readers are never blocked), and an
-- `as_of` column evaluated at refresh time, surfaced to clients as `asOf`.
--
-- Amount columns are TEXT in `intents` (bigint-as-string convention); every
-- sum casts to NUMERIC, never to a float. Empty strings and NULLs count as 0,
-- matching BigInt("") === 0n in the in-code aggregation these replace.
-- Canary exclusion (CANARY_ADDRESSES) is runtime config, so it is applied by
-- the application as an indexed subtraction, not baked into the views.

-- Backs the live last-24h fee window, which a periodically refreshed view
-- cannot answer exactly.
-- squawk-ignore create-index-without-concurrently
-- justification: Prisma runs each migration in a transaction, which forbids CONCURRENTLY. The index is partial (fee-bearing rows only); on very large tables pre-create it CONCURRENTLY out of band and IF NOT EXISTS makes this a no-op.
CREATE INDEX IF NOT EXISTS "intents_fee_filled_at_idx"
    ON "intents" ("filled_at")
    WHERE "fee_amount" IS NOT NULL AND "fee_amount" <> '';

-- ── mv_protocol_stats: one row of protocol-wide totals ──────────────────────
CREATE MATERIALIZED VIEW "mv_protocol_stats" AS
SELECT
    1                                                                   AS "id",
    count(*)::BIGINT                                                    AS "total_intents",
    count(*) FILTER (WHERE "state" = 'open')::BIGINT                    AS "open_intents",
    count(*) FILTER (WHERE "state" = 'filled')::BIGINT                  AS "filled_intents",
    COALESCE(sum(COALESCE(NULLIF("fill_amount", ''), '0')::NUMERIC)
             FILTER (WHERE "state" = 'filled'), 0)                      AS "total_volume",
    count(DISTINCT "user")::BIGINT                                      AS "unique_users",
    COALESCE(sum("filled_at" - "created_at")
             FILTER (WHERE "state" = 'filled' AND "filled_at" IS NOT NULL), 0)::BIGINT
                                                                        AS "fill_seconds_sum",
    count(*) FILTER (WHERE "state" = 'filled' AND "filled_at" IS NOT NULL)::BIGINT
                                                                        AS "fill_seconds_count",
    COALESCE(sum("fee_amount"::NUMERIC)
             FILTER (WHERE "fee_amount" IS NOT NULL AND "fee_amount" <> ''), 0)
                                                                        AS "total_fees",
    count(*) FILTER (WHERE "fee_amount" IS NOT NULL AND "fee_amount" <> '')::BIGINT
                                                                        AS "fee_intents",
    now()                                                               AS "as_of"
FROM "intents";

-- squawk-ignore create-index-without-concurrently
-- justification: the materialised view is created in this same migration; CONCURRENTLY is not allowed inside the migration transaction and there is nothing to lock.
CREATE UNIQUE INDEX "mv_protocol_stats_id_key" ON "mv_protocol_stats" ("id");

-- ── mv_per_chain_stats: the same totals per source chain ────────────────────
CREATE MATERIALIZED VIEW "mv_per_chain_stats" AS
SELECT
    "src_chain"::TEXT                                                   AS "chain",
    count(*)::BIGINT                                                    AS "total_intents",
    count(*) FILTER (WHERE "state" = 'open')::BIGINT                    AS "open_intents",
    count(*) FILTER (WHERE "state" = 'filled')::BIGINT                  AS "filled_intents",
    COALESCE(sum(COALESCE(NULLIF("fill_amount", ''), '0')::NUMERIC)
             FILTER (WHERE "state" = 'filled'), 0)                      AS "total_volume",
    COALESCE(sum("filled_at" - "created_at")
             FILTER (WHERE "state" = 'filled' AND "filled_at" IS NOT NULL), 0)::BIGINT
                                                                        AS "fill_seconds_sum",
    count(*) FILTER (WHERE "state" = 'filled' AND "filled_at" IS NOT NULL)::BIGINT
                                                                        AS "fill_seconds_count",
    COALESCE(sum("fee_amount"::NUMERIC)
             FILTER (WHERE "fee_amount" IS NOT NULL AND "fee_amount" <> ''), 0)
                                                                        AS "total_fees",
    count(*) FILTER (WHERE "fee_amount" IS NOT NULL AND "fee_amount" <> '')::BIGINT
                                                                        AS "fee_intents",
    now()                                                               AS "as_of"
FROM "intents"
GROUP BY "src_chain";

-- squawk-ignore create-index-without-concurrently
-- justification: the materialised view is created in this same migration (see above).
CREATE UNIQUE INDEX "mv_per_chain_stats_chain_key" ON "mv_per_chain_stats" ("chain");

-- ── mv_solver_leaderboard: all-time per-solver stats from solver_fills ──────
-- percentile_disc is nearest-rank, matching the in-memory adapter exactly.
CREATE MATERIALIZED VIEW "mv_solver_leaderboard" AS
SELECT
    "solver",
    count(*) FILTER (WHERE "outcome" = 'filled')::BIGINT                AS "fills_completed",
    GREATEST(count(*) FILTER (WHERE "outcome" = 'failed')
             - count(*) FILTER (WHERE "outcome" = 'reversed'), 0)::BIGINT
                                                                        AS "fills_failed",
    COALESCE(sum("dst_amount") FILTER (WHERE "outcome" = 'filled'), 0)  AS "total_volume",
    sum("usd_value") FILTER (WHERE "outcome" = 'filled')                AS "total_volume_usd",
    avg("fill_seconds") FILTER (WHERE "outcome" = 'filled')             AS "avg_fill_seconds",
    percentile_disc(0.5) WITHIN GROUP (ORDER BY "fill_seconds")
        FILTER (WHERE "outcome" = 'filled' AND "fill_seconds" IS NOT NULL)
                                                                        AS "p50_fill_seconds",
    percentile_disc(0.95) WITHIN GROUP (ORDER BY "fill_seconds")
        FILTER (WHERE "outcome" = 'filled' AND "fill_seconds" IS NOT NULL)
                                                                        AS "p95_fill_seconds",
    now()                                                               AS "as_of"
FROM "solver_fills"
GROUP BY "solver";

-- squawk-ignore create-index-without-concurrently
-- justification: the materialised view is created in this same migration (see above).
CREATE UNIQUE INDEX "mv_solver_leaderboard_solver_key" ON "mv_solver_leaderboard" ("solver");
