-- Reverses 20261020000002_stats_materialized_views. The views are derived
-- data, so nothing is lost; set STATS_SOURCE=live before rolling back so the
-- application stops reading them.
DROP MATERIALIZED VIEW IF EXISTS "mv_solver_leaderboard";
DROP MATERIALIZED VIEW IF EXISTS "mv_per_chain_stats";
DROP MATERIALIZED VIEW IF EXISTS "mv_protocol_stats";
DROP INDEX IF EXISTS "intents_fee_filled_at_idx";
