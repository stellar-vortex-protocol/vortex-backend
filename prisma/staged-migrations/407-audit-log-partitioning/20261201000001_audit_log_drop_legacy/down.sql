-- Irreversible: the legacy table's rows were verified to exist in the
-- partitioned table before the drop, so nothing is lost, but the legacy
-- table itself is not recreated. Roll back the swap from a backup if needed.
SELECT 1;
