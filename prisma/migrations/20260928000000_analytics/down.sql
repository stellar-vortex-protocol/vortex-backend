-- Reverse the analytics migration. Retention/refresh policies are dropped
-- implicitly with their continuous aggregates.

DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_1d";
DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_1h";
DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_1m";
DROP TABLE IF EXISTS "analytics_fills";
