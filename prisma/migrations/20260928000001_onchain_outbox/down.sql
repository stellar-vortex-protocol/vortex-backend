-- Rollback for 20260928000001_onchain_outbox.
-- WARNING: drops any unsent outbox rows. Drain the relay (no pending/processing/
-- submitted rows) before rolling back, or those on-chain writes are lost.
DROP TABLE IF EXISTS "onchain_outbox";
DROP TYPE IF EXISTS "OutboxStatus";
