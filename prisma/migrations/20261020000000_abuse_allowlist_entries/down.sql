-- Rollback for 20261020000000_abuse_allowlist_entries.
-- Dropping the table discards runtime-added allowlist entries; entries seeded
-- from ABUSE_ALLOWLIST are unaffected because they live in the environment.
DROP INDEX CONCURRENTLY IF EXISTS "abuse_allowlist_entries_type_value_key";
DROP TABLE IF EXISTS "abuse_allowlist_entries";
DROP TYPE IF EXISTS "AbuseAllowlistEntryType";
