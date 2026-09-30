-- Rollback for 20260929000001_contract_upgrades. Drops the upgrade history;
-- the recorded rows cannot be restored.
DROP TABLE IF EXISTS "contract_upgrades";
