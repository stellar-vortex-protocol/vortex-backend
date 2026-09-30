-- Analytics layer (docs/adr/0001-analytics-store.md).
--
-- Requires the `timescale/timescaledb` PostgreSQL image (see docker-compose.yml);
-- `CREATE EXTENSION timescaledb` is unavailable on the stock postgres image.
-- The migration-rollback CI job must use the same timescale image (follow-up to #118).

-- TimescaleDB + approximate-percentile toolkit (p95 sketches that roll up).
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

-- Raw fill events. Ingestion is idempotent: the (event_id, time) primary key
-- lets the writer use `ON CONFLICT DO NOTHING` for replays and late data.
CREATE TABLE "analytics_fills" (
    "event_id"     TEXT        NOT NULL,
    "time"         TIMESTAMPTZ NOT NULL,
    "chain"        TEXT        NOT NULL,
    "src_token"    TEXT        NOT NULL,
    "dst_token"    TEXT        NOT NULL,
    "solver"       TEXT        NOT NULL,
    "volume"       NUMERIC     NOT NULL,
    "fees"         NUMERIC     NOT NULL,
    "duration_ms"  INTEGER     NOT NULL,
    PRIMARY KEY ("event_id", "time")
);

SELECT create_hypertable('analytics_fills', 'time', if_not_exists => TRUE);

-- 1-minute continuous aggregate (additive sums + a mergeable p95 sketch).
CREATE MATERIALIZED VIEW "analytics_fills_1m"
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', "time") AS bucket,
    "chain",
    "src_token",
    "dst_token",
    "solver",
    sum("volume")       AS volume,
    sum("fees")         AS fees,
    sum("duration_ms")  AS duration_sum,
    count(*)            AS fills,
    uddsketch("duration_ms", 0.01) AS duration_sketch
FROM "analytics_fills"
GROUP BY bucket, "chain", "src_token", "dst_token", "solver";

-- 1-hour aggregate, rolled up from the 1-minute view.
CREATE MATERIALIZED VIEW "analytics_fills_1h"
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    "chain",
    "src_token",
    "dst_token",
    "solver",
    sum(volume)       AS volume,
    sum(fees)         AS fees,
    sum(duration_sum) AS duration_sum,
    sum(fills)        AS fills,
    rollup(duration_sketch) AS duration_sketch
FROM "analytics_fills_1m"
GROUP BY bucket, "chain", "src_token", "dst_token", "solver";

-- 1-day aggregate, rolled up from the 1-hour view.
CREATE MATERIALIZED VIEW "analytics_fills_1d"
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    "chain",
    "src_token",
    "dst_token",
    "solver",
    sum(volume)       AS volume,
    sum(fees)         AS fees,
    sum(duration_sum) AS duration_sum,
    sum(fills)        AS fills,
    rollup(duration_sketch) AS duration_sketch
FROM "analytics_fills_1h"
GROUP BY bucket, "chain", "src_token", "dst_token", "solver";

-- Retention: raw 30 days, 1m 90 days, 1h 1 year, 1d kept indefinitely.
SELECT add_retention_policy('analytics_fills', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('analytics_fills_1m', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('analytics_fills_1h', INTERVAL '1 year', if_not_exists => TRUE);

-- Refresh policies: re-aggregate late-arriving / reconciled data.
SELECT add_continuous_aggregate_policy('analytics_fills_1m',
    start_offset => INTERVAL '1 hour', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('analytics_fills_1h',
    start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('analytics_fills_1d',
    start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 day', if_not_exists => TRUE);
