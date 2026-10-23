-- Chain-pair (issue #593) and slippage (issue #594) analytics.
-- See docs/adr/0001-analytics-store.md.
--
-- Rows recorded before this migration get dst_chain = 'unknown' through the
-- column default. There is no backfill: the raw table does not know the real
-- destination of those fills. quoted_dst_amount stays NULL for them, which
-- excludes them from the slippage metric.
--
-- The existing analytics_fills_{1m,1h,1d} aggregates do not reference either
-- new column, so they keep working unchanged.

ALTER TABLE "analytics_fills" ADD COLUMN IF NOT EXISTS "dst_chain" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "analytics_fills" ADD COLUMN IF NOT EXISTS "quoted_dst_amount" NUMERIC;

-- Corridor volume per (src_chain, dst_chain). Token columns are kept so the
-- `token` filter still works on chain-pair queries. Created WITH DATA (the
-- default), so existing rows are materialised under dst_chain = 'unknown'.
CREATE MATERIALIZED VIEW "analytics_fills_chain_pair_1m"
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', "time") AS bucket,
    "chain"     AS src_chain,
    "dst_chain",
    "src_token",
    "dst_token",
    sum("volume") AS volume,
    count(*)      AS fills
FROM "analytics_fills"
GROUP BY bucket, "chain", "dst_chain", "src_token", "dst_token";

CREATE MATERIALIZED VIEW "analytics_fills_chain_pair_1h"
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    src_chain,
    "dst_chain",
    "src_token",
    "dst_token",
    sum(volume) AS volume,
    sum(fills)  AS fills
FROM "analytics_fills_chain_pair_1m"
GROUP BY bucket, src_chain, "dst_chain", "src_token", "dst_token";

CREATE MATERIALIZED VIEW "analytics_fills_chain_pair_1d"
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    src_chain,
    "dst_chain",
    "src_token",
    "dst_token",
    sum(volume) AS volume,
    sum(fills)  AS fills
FROM "analytics_fills_chain_pair_1h"
GROUP BY bucket, src_chain, "dst_chain", "src_token", "dst_token";

-- Same retention and refresh windows as analytics_fills_{1m,1h,1d}.
SELECT add_retention_policy('analytics_fills_chain_pair_1m', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('analytics_fills_chain_pair_1h', INTERVAL '1 year', if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('analytics_fills_chain_pair_1m',
    start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('analytics_fills_chain_pair_1h',
    start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('analytics_fills_chain_pair_1d',
    start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 day', if_not_exists => TRUE);
