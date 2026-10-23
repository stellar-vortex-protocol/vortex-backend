-- Reverse 20261020000000_analytics_chain_pair_slippage. Policies are dropped
-- with their continuous aggregates. Dropping the columns discards any recorded
-- destination chains and quoted amounts; they cannot be restored.

DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_chain_pair_1d";
DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_chain_pair_1h";
DROP MATERIALIZED VIEW IF EXISTS "analytics_fills_chain_pair_1m";

ALTER TABLE "analytics_fills" DROP COLUMN IF EXISTS "quoted_dst_amount";
ALTER TABLE "analytics_fills" DROP COLUMN IF EXISTS "dst_chain";
